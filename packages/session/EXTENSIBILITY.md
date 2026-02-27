# Session Extensibility

This guide covers custom storage backends and child session persistence patterns.

## Writing a Custom SessionStore

Custom storage backends implement the `SessionStore` interface.

```typescript
interface SessionStore {
  list(): Promise<SessionMetadata[]>;
  load(id: string): Promise<{ metadata: SessionMetadata; messages: Message[] } | undefined>;
  save(id: string, messages: Message[], metadata?: Partial<SessionMetadata>): Promise<void>;
  delete(id: string): Promise<boolean>;
}
```

### Example: Key-Value Store

```typescript
import type { SessionStore, SessionMetadata } from "@simulacra-ai/session";
import type { Message } from "@simulacra-ai/core";

class KVSessionStore implements SessionStore {
  #kv: KVClient;

  constructor(kv: KVClient) {
    this.#kv = kv;
  }

  async list() {
    const keys = await this.#kv.keys("session:*");
    const entries = await Promise.all(keys.map((k) => this.#kv.get(k)));
    return entries
      .map((e) => e.metadata as SessionMetadata)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async load(id: string) {
    return this.#kv.get(`session:${id}`) as
      | { metadata: SessionMetadata; messages: Message[] }
      | undefined;
  }

  async save(id: string, messages: Message[], metadata?: Partial<SessionMetadata>) {
    const now = new Date().toISOString();
    const existing = await this.load(id);
    await this.#kv.set(`session:${id}`, {
      metadata: {
        id,
        ...existing?.metadata,
        created_at: existing?.metadata.created_at ?? now,
        updated_at: now,
        message_count: messages.length,
        ...metadata,
      },
      messages,
    });
  }

  async delete(id: string) {
    return this.#kv.delete(`session:${id}`);
  }
}
```

## Child Session Storage

When `SessionManager` creates child sessions (for orchestration subagents, checkpoints, or manual `spawn_child` calls), it uses **detached forks**. A detached fork records its `parent_id` but starts with an empty conversation. The child gets its own context.

Custom `SessionStore` implementations should handle these metadata fields on child sessions:

Field|Description
-|-
`parent_id`|ID of the parent session
`fork_message_id`|Last message ID from the parent at fork time
`detached`|Whether parent context is excluded
`is_checkpoint`|Whether this is a checkpoint summarization session

**Attached forks** (used by `fork()` without `detached: true`) inherit parent message history. Loading an attached fork walks the parent chain and reconstructs messages from root to fork point. Storage backends need to preserve the `parent_id` and `fork_message_id` fields so the session manager can reconstruct the full message history.

## License

MIT
