# Simulacra Session

The session package makes Simulacra conversations durable. Conversations are stateful, but that state lives in memory and disappears when the process exits. The session manager handles saving, loading, and labeling sessions with pluggable storage backends. Sessions can be resumed across process restarts, forked into branches, and automatically saved as the conversation progresses.

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/session
```

## Quick Start

```typescript
import { Conversation } from "@simulacra-ai/core";
import { FileSessionStore, SessionManager } from "@simulacra-ai/session";

// assuming provider is already configured

// create a conversation
using conversation = new Conversation(provider);

// create a session manager backed by the filesystem
const store = new FileSessionStore("./sessions");
using session = new SessionManager(store, conversation);

// start a new session
session.start_new("my first session");

// conversation happens, messages are saved automatically
await conversation.prompt("Hello!");
```

With `auto_save` (default `true`), messages are persisted after each model response without any manual save calls.

## SessionManager

The `SessionManager` coordinates a conversation with a storage backend. It handles the full lifecycle of sessions, from creation through saving to disposal.

```typescript
new SessionManager(store, conversation, options?)
```

The constructor accepts the following options.

Option|Type|Default|Description
-|-|-|-
`auto_save`|`boolean`|`true`|Save after every `message_complete` event
`auto_slug`|`boolean`|`true`|Derive a label from the first user message

### Methods

The session manager exposes the following methods.

Method|Description
-|-
`start_new(label?)`|Begin a new session, returns the session ID
`load(id?)`|Load a session by ID, or the most recent if omitted
`save(metadata?)`|Persist current messages and metadata
`fork(parent_id, options?)`|Create a child session branching from a parent, returns the new session ID
`list()`|List all sessions from the store
`delete(id)`|Remove a session
`rename(id, label)`|Change a session's label

### Events

The session manager emits events as sessions are loaded and saved.

Event|Payload|When
-|-|-
`load`|`{ id, messages }`|Session loaded from store
`save`|`{ id, messages }`|Session written to store
`lifecycle_error`|`{ error, operation, context? }`|Infrastructure or lifecycle failure
`dispose`|(none)|Manager disposed

### Auto-Slug

When `auto_slug` is enabled, the session manager derives a label from the first ~50 characters of the first user message, trimmed to a word boundary. This runs once on the first save. Explicitly setting a label via `start_new(label)` or `rename()` takes precedence.

### Child Sessions

When a child conversation is spawned (via orchestration, checkpoints, or `spawn_child`), the session manager automatically creates a child session backed by a detached fork. Child sessions auto-save independently and are disposed when the child conversation ends. This means orchestration subagents, checkpoint summaries, and other child conversations all get their own persistent session history without any manual setup.

Checkpoint children have `auto_slug` disabled since their sessions are internal.

## Session Storage

A `SessionStore` is the storage backend that a `SessionManager` reads from and writes to. The store handles listing, loading, saving, and deleting sessions. Three stores are included out of the box.

**FileSessionStore** persists sessions as JSON files on disk. Each session is a single `{id}.json` file. Child session relationships are indexed using hard links under `{parent-id}-forks/` directories.

```typescript
const store = new FileSessionStore("./data/sessions");
```

**InMemorySessionStore** is a non-persistent store for testing and development. Sessions live in a `Map` and are lost on process exit.

```typescript
const store = new InMemorySessionStore();
```

**DrizzleSessionStore** persists sessions in a relational database using Drizzle ORM. It works with any database that Drizzle supports (PostgreSQL, MySQL, SQLite). The store does not import `drizzle-orm` itself. Instead, it accepts an adapter object with `list`, `load`, `upsert`, and `delete` functions that wrap Drizzle queries against the application's table.

```typescript
import { DrizzleSessionStore } from "@simulacra-ai/session";

const store = new DrizzleSessionStore({
  list: () =>
    db.select().from(sessionsTable).orderBy(desc(sessionsTable.updated_at)),
  load: async (id) => {
    const [row] = await db
      .select({ metadata: sessionsTable.metadata, messages: sessionsTable.messages })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, id));
    return row;
  },
  upsert: (row) =>
    db.insert(sessionsTable).values(row).onConflictDoUpdate({
      target: sessionsTable.id,
      set: { metadata: row.metadata, messages: row.messages, updated_at: row.updated_at },
    }),
  delete: async (id) => {
    const result = await db.delete(sessionsTable).where(eq(sessionsTable.id, id));
    return result.rowCount > 0;
  },
});
```

The `DrizzleSessionRow` and `DrizzleSessionAdapter` types are exported for reference when defining a table schema and adapter. See the JSDoc on `DrizzleSessionRow` for example PostgreSQL and SQLite table definitions.

Custom storage backends (databases, cloud storage, key-value stores) can be built by implementing the `SessionStore` interface. The [extensibility guide](EXTENSIBILITY.md) covers the interface, implementation notes, and includes a full example.

## License

MIT
