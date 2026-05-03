# @simulacra-ai/stream-server

Server-side encoder that exposes a `@simulacra-ai/core` `Conversation` as a typed event stream, plus thin transport adapters for NDJSON, SSE, and WebSockets. Pair with `@simulacra-ai/stream-client` on the consumer side.

## Install

```bash
npm install @simulacra-ai/stream-server @simulacra-ai/core
```

## Encode a conversation

`encode_conversation` returns a `ReadableStream<WireEvent>` — typed events, no byte encoding. Pipe through a transport adapter (or iterate directly).

```ts
import { encode_conversation, to_ndjson_stream } from "@simulacra-ai/stream-server";

app.post("/api/chat", async (c) => {
  const conversation = build_conversation_for(c.req);
  const abort = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const events = encode_conversation(conversation, {
    abort_signal: abort.signal,   // cancels conversation on client disconnect
    timeout_ms: 60_000,            // emits lifecycle_error and closes on expiry
  });

  // Kick off the model turn. Errors surface through the stream as
  // `request_error` events, so swallowing the unhandled-rejection here is safe.
  void conversation.prompt(await c.req.text()).catch(() => {});

  const { body, headers } = to_ndjson_stream(events);
  return new Response(body, { headers });
});
```

The encoder closes the stream automatically on `message_complete`, on `request_error`, on timeout, on abort, or when the conversation is disposed. `lifecycle_error` is non-fatal and does not close the stream.

## SSE

```ts
import { encode_conversation, to_sse_stream } from "@simulacra-ai/stream-server";

const { body, headers } = to_sse_stream(encode_conversation(conversation));
return new Response(body, { headers });
```

Each event is framed as `event: <type>\ndata: <json>\n\n`.

## WebSocket

No adapter needed — iterate and send each event:

```ts
for await (const event of encode_conversation(conversation)) {
  ws.send(JSON.stringify(event));
}
```

## Node / Fastify integration

For Fastify, Express, or raw `http.createServer` use the `/node` sub-export to pump the framed body into a `ServerResponse`:

```ts
import { encode_conversation, to_ndjson_stream } from "@simulacra-ai/stream-server";
import { pipe_to_node_response } from "@simulacra-ai/stream-server/node";

reply.hijack();
const abort = new AbortController();
reply.raw.on("close", () => abort.abort());

const { body, headers } = to_ndjson_stream(
  encode_conversation(conversation, { abort_signal: abort.signal }),
);
for (const [k, v] of Object.entries(headers)) reply.raw.setHeader(k, v);
reply.raw.statusCode = 200;
await pipe_to_node_response(body, reply.raw, { abort_signal: abort.signal });
```

`pipe_to_node_response` handles backpressure (`drain` waits), client-close detection, and `res.end()` when the stream finishes.

## API

### `encode_conversation(conversation, options?) → ReadableStream<WireEvent>`

Options:

- `events` — subset of event types to forward. Default forwards:
  - `message_start`
  - `content_start`
  - `content_update`
  - `content_complete`
  - `message_complete`
  - `request_error`
  - `lifecycle_error`
- `include_prompt_send` (default `false`) — forward `prompt_send` events. SECURITY: echoes the user's prompt to every consumer.
- `include_error_stack` (default `false`) — include `error.stack` on serialized errors.
- `transform(event)` — return `undefined` to drop the event, or a replacement event of the same `type`. Intended for redaction.
- `abort_signal` — when aborted, calls `conversation.cancel_response()` and closes the stream.
- `timeout_ms` — emits `lifecycle_error` with `operation: "encoder_timeout"` on expiry, then cancels the conversation and closes.

### `to_ndjson_stream(events) → { body, headers }`

Frames a `ReadableStream<WireEvent>` as NDJSON bytes (one JSON per line). Headers set `Content-Type: application/x-ndjson` plus anti-buffering hints.

### `to_sse_stream(events) → { body, headers }`

Frames as SSE (`event: <type>\ndata: <json>\n\n`). Headers set `Content-Type: text/event-stream`.

### `pipe_to_node_response(stream, res, options?)` (sub-export `/node`)

Pipes a `ReadableStream<Uint8Array>` into a Node `ServerResponse` with backpressure handling and abort propagation.
