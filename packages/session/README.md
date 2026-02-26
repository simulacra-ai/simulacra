# Simulacra Session

Session persistence for the Simulacra conversation engine. Manages saving, loading, and labeling conversation sessions with pluggable storage backends.

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/session
```

## Quick Start

```typescript
import { SessionManager, FileSessionStore } from "@simulacra-ai/session";

const store = new FileSessionStore("./sessions");
const session = new SessionManager(store, conversation);

session.start_new("my first session");
// ... conversation happens ...
await session.save();
```

With `auto_save` (default `true`), messages are saved automatically after each model response.

## SessionManager

`SessionManager` coordinates a conversation with a storage backend and handles the lifecycle of sessions: creation, loading, saving, and disposal.

```typescript
new SessionManager(store, conversation, options?)
```

Option|Type|Default|Description
-|-|-|-
`auto_save`|`boolean`|`true`|Save after every `message_complete` event
`auto_slug`|`boolean`|`true`|Derive a label from the first user message

### Methods

Method|Description
-|-
`start_new(label?)`|Begin a new session, returns the session ID
`load(id?)`|Load a session by ID, or the most recent if omitted
`save(metadata?)`|Persist current messages and metadata
`fork(parent_id, options?)`|Create a child session branching from a parent
`list()`|List all sessions from the store
`delete(id)`|Remove a session
`rename(id, label)`|Change a session's label

### Events

Event|Payload|When
-|-|-
`load`|`{ id, messages }`|Session loaded from store
`save`|`{ id, messages }`|Session written to store
`dispose`|(none)|Manager disposed

### Auto-Slug

When `auto_slug` is enabled, `SessionManager` derives a label from the first ~50 characters of the first user message (trimmed to a word boundary). This runs once on the first save; explicitly setting a label via `start_new(label)` or `rename()` takes precedence.

### Child Sessions

`SessionManager` listens for the conversation's `create_child` event. When a child conversation is spawned — via orchestration, checkpoints, or `spawn_child` — the session manager automatically creates a child session backed by a detached fork. Child sessions auto-save independently and are disposed when the child conversation ends.

Checkpoint children have `auto_slug` disabled since their sessions are internal.

## Built-in Stores

### FileSessionStore

Persists sessions as JSON files on disk. Each session is a single `{id}.json` file.

```typescript
import { FileSessionStore } from "@simulacra-ai/session";

const store = new FileSessionStore("./data/sessions");
```

Child session relationships are indexed using hard links under `{parent-id}-forks/` directories.

### InMemorySessionStore

Non-persistent store for testing. Sessions live in a `Map` and are lost on process exit.

```typescript
import { InMemorySessionStore } from "@simulacra-ai/session";

const store = new InMemorySessionStore();
```

## SessionStore Interface

Custom storage backends implement the `SessionStore` interface. See the [extensibility guide](EXTENSIBILITY.md) for implementation details and examples.

```typescript
interface SessionStore {
  list(): Promise<SessionMetadata[]>;
  load(id: string): Promise<{ metadata: SessionMetadata; messages: Message[] } | undefined>;
  save(id: string, messages: Message[], metadata?: Partial<SessionMetadata>): Promise<void>;
  delete(id: string): Promise<boolean>;
}
```

## License

MIT
