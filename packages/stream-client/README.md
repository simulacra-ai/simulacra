# @simulacra-ai/stream-client

Client-side counterpart to `@simulacra-ai/stream-server`. Decodes a wire-format byte stream into typed `WireEvent`s and offers `RemoteConversation` — a facade that mirrors the local `Conversation` event-bus surface so UI code can be written once and swapped between local and remote conversations.

Transport-agnostic: `RemoteConversation` and `collect_conversation_result` consume any `AsyncIterable<WireEvent>`. Use `decode_ndjson` for HTTP NDJSON responses; for SSE or WebSocket sources, write a small generator that yields `WireEvent`s.

## Install

```bash
npm install @simulacra-ai/stream-client @simulacra-ai/core
```

`@simulacra-ai/core` is declared as a peer dependency. The client package uses it only for type imports — no runtime dependency — but the install line above is still required (npm doesn't resolve types from peer-only declarations).

## RemoteConversation (NDJSON over HTTP)

The headline API. Treats a remote conversation's stream like a local one's event bus.

```ts
import { RemoteConversation, decode_ndjson } from "@simulacra-ai/stream-client";

const res = await fetch("/api/chat", { method: "POST", body });
if (!res.body) throw new Error("missing body");

const conv = new RemoteConversation(decode_ndjson(res.body));

conv.on("content_update", ({ content }) => {
  if (content?.type === "text" && content.text) {
    // `content.text` is the cumulative text so far — to render only the
    // newly-arrived chunk, slice off the previous length.
    ui.appendText(content.text);
  }
});

const { text, tool_calls } = await conv.consume();
```

Single-use: each `RemoteConversation` wraps one event source. After `consume()` resolves or rejects, the instance is exhausted.

## WebSocket

Adapt the socket as an async iterable of `WireEvent`s and pass it in:

```ts
import type { WireEvent } from "@simulacra-ai/core";
import { RemoteConversation } from "@simulacra-ai/stream-client";

async function* events_from_ws(ws: WebSocket): AsyncGenerator<WireEvent> {
  for await (const msg of /* your ws message iterator */) {
    yield JSON.parse(msg.data) as WireEvent;
  }
}

const conv = new RemoteConversation(events_from_ws(ws));
```

## Lower-level helpers

For consumers that don't want the facade:

```ts
import { decode_ndjson, collect_conversation_result } from "@simulacra-ai/stream-client";

// per-event streaming
for await (const event of decode_ndjson(res.body)) {
  // ...
}

// one-shot aggregate
const { text, tool_calls } = await collect_conversation_result(decode_ndjson(res.body));
```

## API

### `RemoteConversation`

- `new RemoteConversation(source: AsyncIterable<WireEvent>)`
- `.on(type, listener)`, `.off(type, listener)`, `.once(type, listener)` — typed per `WireEventType`. Listener receives the event's `data` payload.
- `.consume(options?)` → `Promise<ConversationResult>`. Drains, dispatches, aggregates, throws on `request_error` / `lifecycle_error`.

### `decode_ndjson(source, options?) → AsyncGenerator<WireEvent>`

Parse an NDJSON byte stream. Handles partial-line buffering, CRLF, and UTF-8 boundaries.

Options:

- `on_parse_error` — `"throw"` (default), `"skip"`, or a callback returning a replacement event.
- `abort_signal` — cancel the underlying reader and exit cleanly.

### `collect_conversation_result(events) → Promise<{ text, tool_calls }>`

Drain an `AsyncIterable<WireEvent>` and return the aggregated text + tool calls extracted from `message_complete`. Throws on `request_error` / `lifecycle_error`.

### `collect_ndjson(source, options?)`

Test/utility helper. Drains an NDJSON byte stream into `WireEvent[]`. Don't use on long-lived streams.
