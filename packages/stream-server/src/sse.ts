import { serialize_error, type WireEvent } from "@simulacra-ai/core";

export const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";

export const SSE_DEFAULT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": SSE_CONTENT_TYPE,
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
});

export interface SseStream {
  body: ReadableStream<Uint8Array>;
  headers: Record<string, string>;
}

/**
 * Frame a `WireEvent` stream as SSE bytes (`event: <type>\ndata: <json>\n\n`).
 * Each JSON payload is single-line — SSE forbids embedded newlines in `data:`,
 * and `JSON.stringify` already escapes them.
 */
export function to_sse_stream(events: ReadableStream<WireEvent>): SseStream {
  const text = new TextEncoder();
  const body = events.pipeThrough(
    new TransformStream<WireEvent, Uint8Array>({
      transform(event, controller) {
        try {
          const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(text.encode(frame));
        } catch (err) {
          const fallback: WireEvent = {
            type: "lifecycle_error",
            data: {
              operation: "sse_serialize",
              error: serialize_error(err, false),
            },
          };
          try {
            const frame = `event: ${fallback.type}\ndata: ${JSON.stringify(fallback)}\n\n`;
            controller.enqueue(text.encode(frame));
          } catch {
            /* swallow */
          }
        }
      },
    }),
  );
  return { body, headers: { ...SSE_DEFAULT_HEADERS } };
}
