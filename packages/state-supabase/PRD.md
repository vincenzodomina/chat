## Title
Add `@chat-adapter/state-supabase` for Supabase-native production state

## Issue body
### Summary

I would like a Supabase-native state adapter for Chat SDK:

```ts
import { createSupabaseState } from "@chat-adapter/state-supabase";
```

Even though Supabase uses Postgres under the hood, the existing `@chat-adapter/state-pg` adapter is not a good fit for apps that are already built around Supabase as the primary database and access layer.

### Why this is needed

In my app, Supabase is already the standard way all database access is handled. I want the Chat SDK state adapter to fit into that same model instead of introducing a second, parallel database access path.

My main requirements are:

- I already use Supabase throughout the app and want to stay within that stack.
- I want to reuse the existing Supabase client from my app instead of managing a separate direct Postgres connection URL.
- I want database access to stay centrally controlled through the same Supabase client/configuration patterns I already use.
- I want schema creation and evolution to be managed through my Supabase declarative schema/migrations, not auto-created at runtime.
- I want security, grants, roles, and schema exposure to be explicitly controlled in my Supabase setup.
- I want the adapter internals to reuse Supabase best practices and stable APIs, such as `supabase-js`, PostgREST, and RPCs where appropriate.
- I want the operational convenience of using only Supabase, with no extra direct DB connection setup and no extra cache/infra dependency.

### Why `@chat-adapter/state-pg` is not enough

`@chat-adapter/state-pg` is technically Postgres-based, but operationally it solves a different problem.

For a Supabase app, the gaps are:

- It expects a direct Postgres connection or `pg` client, not a Supabase client.
- It introduces another database access mechanism alongside the rest of the app.
- It pushes me toward managing separate raw Postgres credentials/URLs instead of reusing the centrally managed Supabase access path.
- It creates its own schema objects on `connect()`, which does not fit teams that manage DB objects declaratively through Supabase migrations.
- It does not align with Supabase-specific security and schema management workflows.
- It does not take advantage of Supabase-native patterns for RPC-based atomic operations and controlled API exposure.

So while Supabase is "just Postgres" underneath, the developer workflow, security model, and operational model are materially different.

### Desired developer experience

Something like this:

```ts
import { createClient } from "@/lib/supabase/server";
import { createSupabaseState } from "@chat-adapter/state-supabase";

const supabase = await createClient();

const bot = new Chat({
  userName: "mybot",
  adapters,
  state: createSupabaseState({ client: supabase }),
});
```

### Desired packaging/setup model

- The package should ship a copy-paste SQL migration file that users can add to their own declarative schema folder.
- The migration should support using a dedicated schema, not require `public`.
- The adapter should work against that schema using Supabase APIs.
- Runtime schema creation should not be required.
- Security/grants should remain under user control.

### Implementation direction

A good fit would be:

- `createSupabaseState({ client, keyPrefix?, logger? })`
- use `supabase-js` internally
- use standard Supabase APIs where possible
- use RPCs for the operations that require atomicity or better performance
- keep behavior functionally equivalent to the existing production Postgres adapter from a Chat SDK perspective

### Acceptance criteria

- New package: `@chat-adapter/state-supabase`
- Accepts an existing `SupabaseClient`
- Does not require direct Postgres URLs
- Ships SQL schema/migration assets for declarative setup
- Uses a dedicated non-public schema (`chat_state`) for state tables and RPCs
- Supports production state features equivalent to the Postgres adapter:
    - subscriptions
    - distributed locking
    - key-value cache with TTL
    - list operations
- Uses Supabase-native access patterns rather than raw `pg`
- Works well for apps that already standardized on Supabase as their backend platform