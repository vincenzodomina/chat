# RFC: Workflow-Based Modal Actions with `"use step"`

**Status:** Draft
**Author:** v0
**Date:** 2026-02-15

## Summary

Replace the current `bot.onAction` / `bot.onModalSubmit` / `bot.onModalClose` string-matcher pattern with an inline, awaitable modal API powered by [Workflow DevKit](https://useworkflow.dev). Instead of scattering handler registration across the file and correlating them through `callbackId` strings, modals become a single awaitable expression inside a `"use workflow"` function. The workflow suspends when a modal is opened, and resumes with the user's submitted values when they interact with it.

## Motivation

### The Problem

Today, handling a modal interaction in chat-sdk requires **three separate registrations** connected by opaque string identifiers:

```tsx
// 1. Register a button handler
bot.onAction("feedback", async (event) => {
  await event.openModal(
    <Modal callbackId="feedback_form" title="Send Feedback" submitLabel="Send">
      <TextInput id="message" label="Your Feedback" multiline />
      <Select id="category" label="Category">
        <SelectOption label="Bug Report" value="bug" />
        <SelectOption label="Feature Request" value="feature" />
      </Select>
    </Modal>,
  );
});

// 2. Register a submit handler (matched by callbackId string)
bot.onModalSubmit("feedback_form", async (event) => {
  if (!event.values.message || event.values.message.length < 5) {
    return { action: "errors", errors: { message: "Too short" } };
  }
  await event.relatedThread?.post(`Feedback: ${event.values.message}`);
});

// 3. Register a close handler (matched by callbackId string)
bot.onModalClose("feedback_form", async (event) => {
  console.log(`${event.user.userName} cancelled feedback`);
});
```

This has several issues:

1. **Scattered logic** -- A single user interaction (click button, fill form, handle result) is split across 3 disconnected handler registrations. You have to mentally trace `callbackId` strings to understand the flow.

2. **String coupling** -- The `"feedback"` action ID and `"feedback_form"` callback ID are magic strings that connect the handlers. Renaming one without the other silently breaks the flow. There's no compile-time safety.

3. **No shared scope** -- The action handler and submit handler can't share local variables. Context must be threaded through `privateMetadata` (serialized JSON strings) or the state adapter, adding boilerplate and another source of bugs.

4. **Linear flows are hard to express** -- Multi-step wizards (modal A -> modal B -> confirmation) require chaining multiple `onModalSubmit` handlers with increasingly complex `privateMetadata` passing. What should be a simple sequential flow becomes a state machine.

5. **No built-in timeout or cancellation** -- If a user opens a modal and walks away, the modal context sits in Redis for 24 hours. There's no ergonomic way to add a timeout or cleanup logic.

### The Vision

What if a modal interaction was just an `await`?

```tsx
bot.onAction("feedback", async (event) => {
  "use workflow";

  const result = await event.openModal(
    <Modal title="Send Feedback" submitLabel="Send">
      <TextInput id="message" label="Your Feedback" multiline />
      <Select id="category" label="Category">
        <SelectOption label="Bug Report" value="bug" />
        <SelectOption label="Feature Request" value="feature" />
      </Select>
    </Modal>,
  );

  // This code runs after the user submits -- same scope, same function
  await event.thread.post(`Feedback (${result.values.category}): ${result.values.message}`);
});
```

No `callbackId`. No `onModalSubmit`. No `privateMetadata`. The workflow suspends when the modal opens and resumes with the form values when the user submits. Cancellation is just a try/catch.

## Design

### Core Primitive: `openModal` Returns a Promise

Today `event.openModal()` returns `Promise<{ viewId: string } | undefined>` -- it fires and forgets. Under the workflow model, it returns `Promise<ModalResult>` -- a promise that **suspends the workflow** until the user submits or closes the modal.

Under the hood, this maps directly to Workflow DevKit's `createWebhook()` pattern:

```ts
// Conceptual implementation inside the Chat class
async openModal(modal: ModalElement | CardJSXElement): Promise<ModalResult> {
  "use step";

  const webhook = createWebhook<ModalWebhookPayload>();

  // Open the modal on the platform, passing webhook.url as the callback
  await adapter.openModal(triggerId, modalElement, { webhookUrl: webhook.url });

  // Workflow suspends here -- no compute consumed while user fills the form
  const payload = await webhook;
  const data = await payload.json();

  if (data.type === "submit") {
    return { action: "submit", values: data.values, user: data.user };
  }

  throw new ModalClosedError(data.user);
}
```

The workflow **suspends** at `await webhook`. When the platform sends the modal submission back to chat-sdk, instead of routing to `onModalSubmit` handlers, the system hits the webhook URL to resume the workflow with the submitted data.

### Inline `onAction` on Button Components

Currently, buttons use an `id` prop and action handlers are registered separately via `bot.onAction("id", handler)`. This RFC proposes an additional `onAction` prop that binds the handler inline:

```tsx
// Current pattern -- string coupling
<Button id="approve">Approve</Button>

bot.onAction("approve", async (event) => { /* ... */ });

// Proposed pattern -- inline binding
<Button onAction={async (event) => {
  "use workflow";
  await event.thread.post("Approved!");
}}>
  Approve
</Button>
```

**How it works:**

1. When the JSX is rendered, `onAction` closures are registered in a per-render handler map keyed by an auto-generated action ID.
2. The `id` prop is auto-generated (e.g., `action_<hash>`) and embedded in the platform payload.
3. When the platform sends back the action event, the Chat class looks up the closure by auto-generated ID and invokes it.
4. Since the closure is a `"use workflow"` function, it becomes a durable workflow run that can suspend/resume.

The existing `id` + `bot.onAction()` pattern continues to work -- `onAction` is purely additive.

### Type-Safe Modal Results

The `openModal` return type encodes the form field IDs and types from the modal definition:

```ts
interface ModalResult<TValues extends Record<string, string> = Record<string, string>> {
  action: "submit";
  values: TValues;
  user: Author;
  viewId: string;
  raw: unknown;
}
```

With generics on the Modal component, we can infer the shape:

```tsx
const result = await event.openModal(
  <Modal<{ message: string; category: string }> title="Feedback">
    <TextInput id="message" label="Message" />
    <Select id="category" label="Category">
      <SelectOption label="Bug" value="bug" />
      <SelectOption label="Feature" value="feature" />
    </Select>
  </Modal>,
);

result.values.message;  // string -- type-safe
result.values.category; // string -- type-safe
result.values.typo;     // TypeScript error
```

### Validation Loop

Server-side validation that sends error messages back to the modal (Slack's `response_action: "errors"` pattern) becomes a simple loop:

```tsx
bot.onAction("report", async (event) => {
  "use workflow";

  let result: ModalResult;
  let errors: Record<string, string> | null = null;

  do {
    result = await event.openModal(
      <Modal title="Report Bug" submitLabel="Submit" errors={errors}>
        <TextInput id="title" label="Bug Title" />
        <TextInput id="steps" label="Steps to Reproduce" multiline />
        <Select id="severity" label="Severity">
          <SelectOption label="Low" value="low" />
          <SelectOption label="High" value="high" />
          <SelectOption label="Critical" value="critical" />
        </Select>
      </Modal>,
    );

    errors = null;
    if (result.values.title.length < 3) {
      errors = { title: "Title must be at least 3 characters" };
    }
  } while (errors);

  await event.thread.post(`Bug filed: ${result.values.title} (${result.values.severity})`);
});
```

Internally, when `errors` is set, the next `openModal` call returns a `response_action: "errors"` response to the platform before suspending again for the next submission.

### Cancellation via Try/Catch

When a user closes a modal (clicks Cancel or the X button), the webhook resolves with a `close` event. The `openModal` implementation throws a `ModalClosedError`:

```tsx
bot.onAction("feedback", async (event) => {
  "use workflow";

  try {
    const result = await event.openModal(
      <Modal title="Feedback" notifyOnClose>
        <TextInput id="message" label="Message" />
      </Modal>,
    );
    await event.thread.post(`Thanks for the feedback: ${result.values.message}`);
  } catch (err) {
    if (err instanceof ModalClosedError) {
      console.log(`${err.user.userName} cancelled the feedback form`);
      // Optionally notify the user
    }
  }
});
```

This replaces `bot.onModalClose()` entirely for workflows. The error is caught in the same scope where the modal was opened, with full access to the surrounding closure.

### Timeout Pattern

Using Workflow DevKit's `sleep()` and `Promise.race`:

```tsx
bot.onAction("approval", async (event) => {
  "use workflow";

  const modalPromise = event.openModal(
    <Modal title="Approve Request" submitLabel="Approve">
      <TextInput id="reason" label="Reason" />
    </Modal>,
  );

  const result = await Promise.race([
    modalPromise,
    sleep("1 hour").then(() => "timeout" as const),
  ]);

  if (result === "timeout") {
    await event.thread.post("Approval request expired after 1 hour.");
    return;
  }

  await event.thread.post(`Approved: ${result.values.reason}`);
});
```

No compute resources are consumed during the sleep or while waiting for the modal -- the workflow is fully suspended.

### Multi-Step Wizard

Sequential modals that would currently require chaining multiple `onModalSubmit` handlers with `privateMetadata` become a simple linear flow:

```tsx
bot.onAction("onboarding", async (event) => {
  "use workflow";

  // Step 1: Basic info
  const step1 = await event.openModal(
    <Modal title="Step 1: Basic Info" submitLabel="Next">
      <TextInput id="name" label="Full Name" />
      <TextInput id="email" label="Email" />
    </Modal>,
  );

  // Step 2: Preferences (has access to step1 values in scope!)
  const step2 = await event.openModal(
    <Modal title={`Step 2: Preferences for ${step1.values.name}`} submitLabel="Next">
      <Select id="team" label="Team">
        <SelectOption label="Engineering" value="eng" />
        <SelectOption label="Design" value="design" />
        <SelectOption label="Product" value="product" />
      </Select>
      <Select id="timezone" label="Timezone">
        <SelectOption label="US Pacific" value="America/Los_Angeles" />
        <SelectOption label="US Eastern" value="America/New_York" />
        <SelectOption label="Europe/London" value="Europe/London" />
      </Select>
    </Modal>,
  );

  // Step 3: Confirmation
  const step3 = await event.openModal(
    <Modal title="Confirm" submitLabel="Complete">
      <TextInput
        id="confirm"
        label={`Confirm onboarding for ${step1.values.name} on ${step2.values.team}?`}
        initialValue="yes"
      />
    </Modal>,
  );

  // All values available in one scope -- no privateMetadata gymnastics
  await event.thread.post(
    `Onboarded ${step1.values.name} (${step1.values.email}) to ${step2.values.team} in ${step2.values.timezone}`,
  );
});
```

### Parallel Modal Collection

Using `Promise.all` with webhooks to collect responses from multiple users:

```tsx
async function collectVotes(thread: Thread, voters: string[]) {
  "use workflow";

  const results = await Promise.all(
    voters.map(async (userId) => {
      const dmThread = await bot.openDM(userId);
      await dmThread.post(
        <Card title="Vote Required">
          <Text>Please submit your vote.</Text>
          <Actions>
            <Button onAction={async (event) => {
              "use workflow";
              const result = await event.openModal(
                <Modal title="Cast Your Vote">
                  <Select id="vote" label="Your Vote">
                    <SelectOption label="Approve" value="approve" />
                    <SelectOption label="Reject" value="reject" />
                    <SelectOption label="Abstain" value="abstain" />
                  </Select>
                  <TextInput id="reason" label="Reason (optional)" optional />
                </Modal>,
              );
              return result.values;
            }}>
              Vote Now
            </Button>
          </Actions>
        </Card>,
      );
    }),
  );

  return results;
}
```

## Implementation

### Architecture

```
                                    ┌──────────────────────────────────────┐
                                    │           Workflow Runtime            │
                                    │                                      │
  User clicks                       │  bot.onAction("feedback", async () { │
  [Feedback] button                 │    "use workflow";                    │
       │                            │                                      │
       ▼                            │    // Step 1: open modal             │
  ┌─────────┐   processAction()     │    const webhook = createWebhook()   │
  │ Platform ├─────────────────────►│    adapter.openModal(triggerId,      │
  │ (Slack)  │                      │      modal, webhook.url)             │
  └─────────┘                       │                                      │
       │                            │    ──── workflow suspends ────        │
       │   User fills form          │         (no compute)                 │
       │   and clicks Submit        │                                      │
       ▼                            │    ──── webhook fires ────           │
  ┌─────────┐  POST webhook.url     │                                      │
  │ Platform ├─────────────────────►│    const result = await webhook      │
  │ (Slack)  │                      │    // { values, user, viewId }       │
  └─────────┘                       │                                      │
                                    │    // Step 2: handle result          │
                                    │    await thread.post(...)            │
                                    │  });                                 │
                                    └──────────────────────────────────────┘
```

### Key Implementation Details

#### 1. Webhook-Based Resumption

The core mechanism uses `createWebhook()` from Workflow DevKit. When `openModal()` is called inside a `"use workflow"` function:

1. A webhook is created via `createWebhook<ModalWebhookPayload>()`
2. The webhook URL is passed to the adapter's `openModal()` method (new `webhookUrl` parameter)
3. The adapter stores the webhook URL alongside the modal's platform-specific metadata
4. When the platform sends a submission/close event, the adapter POSTs to the webhook URL instead of calling `processModalSubmit()`
5. The workflow resumes with the payload

#### 2. Adapter Changes

The `Adapter.openModal()` signature gains an optional `webhookUrl` parameter:

```ts
interface Adapter {
  openModal?(
    triggerId: string,
    modal: ModalElement,
    contextId?: string,
    options?: { webhookUrl?: string },
  ): Promise<{ viewId: string }>;
}
```

When `webhookUrl` is present, the adapter stores it in the modal metadata (e.g., Slack's `private_metadata`). On submission/close, if a webhook URL is found in the metadata, the adapter POSTs to it instead of calling `processModalSubmit()` / `processModalClose()`.

#### 3. Serialization

chat-sdk already has full `@workflow/serde` integration:

- `ThreadImpl` has `WORKFLOW_SERIALIZE` and `WORKFLOW_DESERIALIZE` static methods
- `Message` has the same
- `chat.registerSingleton()` enables lazy adapter resolution after deserialization

The `ActionEvent` and `ModalResult` types will need similar serde support so they can cross the workflow suspension boundary.

#### 4. `onAction` Prop Handler Registry

For inline `onAction` props on `<Button>`:

```ts
// Internal: per-render handler registry
const handlerRegistry = new Map<string, ActionHandler>();

function registerInlineHandler(handler: ActionHandler): string {
  const actionId = `inline_${crypto.randomUUID().slice(0, 8)}`;
  handlerRegistry.set(actionId, handler);
  return actionId;
}
```

During JSX-to-platform conversion, if a `Button` has an `onAction` prop:
1. The handler is registered with an auto-generated ID
2. The `id` prop is set to the auto-generated ID
3. When `processAction()` sees this ID, it invokes the registered handler

**Lifetime management:** Inline handlers are scoped to the message. When the message is deleted or the handler TTL expires (configurable, default 24h), the handlers are cleaned up.

### Backward Compatibility

This is fully **additive**. All existing patterns continue to work:

| Pattern | Status |
|---|---|
| `bot.onAction("id", handler)` | Works as-is |
| `bot.onModalSubmit("callbackId", handler)` | Works as-is |
| `bot.onModalClose("callbackId", handler)` | Works as-is |
| `event.openModal()` (fire-and-forget) | Works as-is outside `"use workflow"` |
| `privateMetadata` | Works as-is |
| `<Button id="x">` | Works as-is |

The new patterns are only active when:
1. The handler function has a `"use workflow"` directive, **or**
2. A `<Button>` has an `onAction` prop

### Migration Path

Users can migrate incrementally, one interaction at a time:

```tsx
// Before: 3 separate registrations
bot.onAction("feedback", async (event) => {
  await event.openModal(<Modal callbackId="feedback_form" ...> ... </Modal>);
});
bot.onModalSubmit("feedback_form", async (event) => { ... });
bot.onModalClose("feedback_form", async (event) => { ... });

// After: single workflow function
bot.onAction("feedback", async (event) => {
  "use workflow";
  try {
    const result = await event.openModal(<Modal ...> ... </Modal>);
    await event.thread.post(`Feedback: ${result.values.message}`);
  } catch (err) {
    if (err instanceof ModalClosedError) { /* handle close */ }
  }
});
```

## Open Questions

1. **Handler registry persistence** -- Should inline `onAction` handlers be persisted to the state adapter so they survive deployments? Or are they ephemeral (scoped to the process lifetime)?

2. **Validation response mechanism** -- How does the workflow return `{ action: "errors", errors: { ... } }` to the platform synchronously? Slack expects this in the HTTP response to the `view_submission` webhook. The webhook-based approach may need a synchronous response path (e.g., the adapter waits briefly for the workflow to resume and produce a validation response).

3. **Platform constraints** -- Slack's trigger IDs expire in 3 seconds. In a multi-step wizard, the second `openModal()` call needs a fresh trigger ID. This may require the submission webhook response to include a new trigger ID, or the adapter to use Slack's `response_action: "push"` to chain views.

4. **Non-workflow usage** -- Should `openModal()` always return `Promise<ModalResult>` even outside `"use workflow"`, making the webhook handling transparent? Or should it only change behavior inside workflows?

5. **Handler cleanup** -- For inline `onAction`, when should the handler be garbage collected? Options: (a) after first invocation, (b) after a TTL, (c) when the message is deleted, (d) never (let the state adapter TTL handle it).

## References

- [Workflow DevKit -- Workflows and Steps](https://useworkflow.dev/docs/foundations/workflows-and-steps)
- [Workflow DevKit -- Common Patterns (webhooks, sleep, Promise.race)](https://useworkflow.dev/docs/foundations/common-patterns)
- [Workflow DevKit -- Hooks & Webhooks](https://useworkflow.dev/docs/foundations/hooks-and-webhooks)
- [Workflow DevKit -- Human-in-the-Loop](https://useworkflow.dev/docs/ai-agents/human-in-the-loop)
- [`packages/chat/src/chat.ts`](../packages/chat/src/chat.ts) -- Current `onAction` / `onModalSubmit` / `onModalClose` pattern
- [`packages/chat/src/types.ts`](../packages/chat/src/types.ts) -- `ActionEvent`, `ModalSubmitEvent`, `ModalCloseEvent` types
- [`packages/chat/src/thread.ts`](../packages/chat/src/thread.ts) -- `WORKFLOW_SERIALIZE` / `WORKFLOW_DESERIALIZE` integration
- [`packages/chat/src/modals.ts`](../packages/chat/src/modals.ts) -- Modal element types and JSX support
- [`packages/adapter-slack/src/modals.ts`](../packages/adapter-slack/src/modals.ts) -- Slack modal view conversion
- [`examples/nextjs-chat/src/lib/bot.tsx`](../examples/nextjs-chat/src/lib/bot.tsx) -- Current usage patterns
