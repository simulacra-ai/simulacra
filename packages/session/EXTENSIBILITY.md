# Session Extensibility

Custom storage backends and child session persistence patterns.

## Writing a Custom SessionStore

Implement the `SessionStore` interface to use any storage backend.

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
  #data = new Map<string, { metadata: SessionMetadata; messages: Message[] }>();

  async list() {
    return [...this.#data.values()]
      .map((d) => d.metadata)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async load(id: string) {
    return this.#data.get(id);
  }

  async save(id: string, messages: Message[], metadata?: Partial<SessionMetadata>) {
    const now = new Date().toISOString();
    const existing = this.#data.get(id);
    this.#data.set(id, {
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
    return this.#data.delete(id);
  }
}
```

### Implementation Notes

- `list()` should return sessions sorted by `updated_at` descending (most recent first). `SessionManager.load()` without an ID loads the first result.
- `save()` receives partial metadata that should be merged with existing metadata. Always preserve `created_at` from the first save and update `updated_at` on every save.
- `save()` may be called frequently when `auto_save` is enabled (once per model response). Consider batching or debouncing for expensive backends.
- `load()` returns `undefined` for missing sessions, not an error.

## Child Session Storage

When `SessionManager` creates child sessions (for orchestration subagents, checkpoints, or manual `spawn_child` calls), it uses **detached forks**. A detached fork records its `parent_id` but starts with an empty conversation — the child gets its own context.

Custom `SessionStore` implementations should handle these metadata fields on child sessions:

Field|Description
-|-
`parent_id`|ID of the parent session
`fork_message_id`|Last message ID from the parent at fork time
`detached`|Whether parent context is excluded
`is_checkpoint`|Whether this is a checkpoint summarization session

**Attached forks** (used by `fork()` without `detached: true`) inherit parent message history. Loading an attached fork walks the parent chain and reconstructs messages from root to fork point. Storage backends that support attached forks need to handle this recursive resolution.
