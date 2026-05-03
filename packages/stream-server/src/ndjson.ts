import { serialize_error, type WireEvent } from "@simulacra-ai/core";

export const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

export const NDJSON_DEFAULT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": NDJSON_CONTENT_TYPE,
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
});

export interface NdjsonStream {
  body: ReadableStream<Uint8Array>;
  headers: Record<string, string>;
}

/**
 * Frame a `WireEvent` stream as NDJSON bytes for HTTP response streaming.
 * One JSON object per line. If `JSON.stringify` throws on an event, a
 * synthetic `lifecycle_error` is emitted in its place.
 */
export function to_ndjson_stream(events: ReadableStream<WireEvent>): NdjsonStream {
  const text = new TextEncoder();
  const body = events.pipeThrough(
    new TransformStream<WireEvent, Uint8Array>({
      transform(event, controller) {
        try {
          controller.enqueue(text.encode(JSON.stringify(event) + "\n"));
        } catch (err) {
          const fallback: WireEvent = {
            type: "lifecycle_error",
            data: {
              operation: "ndjson_serialize",
              error: serialize_error(err, false),
            },
          };
          try {
            controller.enqueue(text.encode(JSON.stringify(fallback) + "\n"));
          } catch {
            /* swallow */
          }
        }
      },
    }),
  );
  return { body, headers: { ...NDJSON_DEFAULT_HEADERS } };
}
