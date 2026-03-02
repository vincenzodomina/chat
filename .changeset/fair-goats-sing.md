---
"@chat-adapter/discord": patch
---

Add Discord slash command support by dispatching `InteractionType.ApplicationCommand` events to `chat.processSlashCommand(...)` while still sending an immediate deferred interaction ACK.
