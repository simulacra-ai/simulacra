import type { Conversation, ConversationEvents } from "@simulacra-ai/core";
import { serialize_error, type WireEvent, type WireEventType } from "@simulacra-ai/core";

export interface EncodeConversationOptions {
  /**
   * Subset of non-`prompt_send` events to forward. `prompt_send` is
   * gated solely by `include_prompt_send` and is independent of this list.
   */
  events?: readonly Exclude<WireEventType, "prompt_send">[];
  /** SECURITY: echoes the user's prompt to every consumer. Off by default. */
  include_prompt_send?: boolean;
  /** Stack traces leak server-side filesystem paths. Off by default. */
  include_error_stack?: boolean;
  /**
   * Redactor: returning `undefined` drops the event. MUST treat input as
   * immutable — simulacra emits the same object to every listener.
   * Cannot change event `type`.
   */
  transform?: (event: WireEvent) => WireEvent | undefined;
  /** Cancel the in-flight LLM call when this aborts (e.g. client disconnect). */
  abort_signal?: AbortSignal;
  /** Hard timeout. `0` / `undefined` / negative values disable. */
  timeout_ms?: number;
}

const DEFAULT_EVENTS: readonly Exclude<WireEventType, "prompt_send">[] = [
  "message_start",
  "content_start",
  "content_update",
  "content_complete",
  "message_complete",
  "request_error",
  "lifecycle_error",
];

/**
 * Encode a `Conversation`'s event bus as a typed `ReadableStream<WireEvent>`.
 * The stream closes after `message_complete` or `request_error`;
 * `lifecycle_error` is non-fatal.
 *
 * Transport-agnostic: pipe through `to_ndjson_stream` for HTTP response
 * streaming, `to_sse_stream` for SSE, or iterate directly to send each
 * event over a WebSocket.
 */
export function encode_conversation(
  conversation: Conversation,
  options: EncodeConversationOptions = {},
): ReadableStream<WireEvent> {
  const include_stack = options.include_error_stack ?? false;
  const enabled = new Set<WireEventType>(options.events ?? DEFAULT_EVENTS);
  // Defense in depth against caller casts: enforce the gate at runtime too.
  if (options.include_prompt_send) {
    enabled.add("prompt_send");
  } else {
    enabled.delete("prompt_send");
  }
  const transform = options.transform;

  const detachers: (() => void)[] = [];
  let closed = false;

  return new ReadableStream<WireEvent>({
    start(controller) {
      const enqueue = (event: WireEvent) => {
        if (closed) {
          return;
        }
        let out = transform ? transform(event) : event;
        if (!out) {
          return;
        }
        // Transforms may not change event type; re-typing breaks consumer dispatch.
        // Surface as a lifecycle_error so a buggy transform doesn't look like a no-op.
        if (out.type !== event.type) {
          const wire_error = serialize_error(
            new Error(
              `transform returned event of type "${out.type}" for input "${event.type}"; type changes are not allowed`,
            ),
            include_stack,
          );
          try {
            controller.enqueue({
              type: "lifecycle_error",
              data: { operation: "encoder_transform", error: wire_error },
            });
          } catch {
            /* controller closed */
          }
          out = event;
        }
        try {
          controller.enqueue(out);
        } catch {
          /* controller closed */
        }
      };

      const close_stream = () => {
        if (closed) {
          return;
        }
        closed = true;
        for (const d of detachers) {
          d();
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const wire = <E extends WireEventType>(
        type: E,
        listener: (...args: ConversationEvents[E & keyof ConversationEvents]) => void,
      ) => {
        if (!enabled.has(type)) {
          return;
        }
        // Catch listener throws so a thrown getter on the payload can't
        // break the producer loop.
        const safe_listener = (...args: ConversationEvents[E & keyof ConversationEvents]): void => {
          try {
            listener(...args);
          } catch (err) {
            const wire_error = serialize_error(err, include_stack);
            try {
              enqueue({
                type: "lifecycle_error",
                data: { operation: "encoder_listener", error: wire_error },
              });
            } catch {
              /* best effort */
            }
          }
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        conversation.on(type as any, safe_listener as any);
        detachers.push(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          conversation.off(type as any, safe_listener as any);
        });
      };

      wire("state_change", (data) => {
        enqueue({ type: "state_change", data });
      });
      wire("prompt_send", (data) => {
        enqueue({ type: "prompt_send", data });
      });
      wire("message_start", (data) => {
        enqueue({ type: "message_start", data });
      });
      wire("message_update", (data) => {
        enqueue({ type: "message_update", data });
      });
      wire("content_start", (data) => {
        enqueue({ type: "content_start", data });
      });
      wire("content_update", (data) => {
        enqueue({ type: "content_update", data });
      });
      wire("content_complete", (data) => {
        enqueue({ type: "content_complete", data });
      });

      const safely = <Args extends unknown[]>(
        fn: (...args: Args) => void,
      ): ((...args: Args) => void) => {
        return (...args: Args): void => {
          try {
            fn(...args);
          } catch (err) {
            const wire_error = serialize_error(err, include_stack);
            try {
              enqueue({
                type: "lifecycle_error",
                data: { operation: "encoder_listener", error: wire_error },
              });
            } catch {
              /* best effort */
            }
          }
        };
      };

      const on_message_complete = safely((data: ConversationEvents["message_complete"][0]) => {
        if (enabled.has("message_complete")) {
          enqueue({ type: "message_complete", data });
        }
        close_stream();
      });
      conversation.on("message_complete", on_message_complete);
      detachers.push(() => {
        conversation.off("message_complete", on_message_complete);
      });

      const on_request_error = safely((data: ConversationEvents["request_error"][0]) => {
        if (enabled.has("request_error")) {
          const wire_error = serialize_error(data.error, include_stack);
          // Strip user prompt and original error object — see WireErrorRequestEvent.
          const { message: _drop_user_prompt, error: _drop_original_error, ...rest } = data;
          enqueue({
            type: "request_error",
            data: { ...rest, error: wire_error },
          });
        }
        close_stream();
      });
      conversation.on("request_error", on_request_error);
      detachers.push(() => {
        conversation.off("request_error", on_request_error);
      });

      const on_lifecycle_error = safely((data: ConversationEvents["lifecycle_error"][0]) => {
        if (enabled.has("lifecycle_error")) {
          const wire_error = serialize_error(data.error, include_stack);
          enqueue({
            type: "lifecycle_error",
            data: { ...data, error: wire_error },
          });
        }
      });
      conversation.on("lifecycle_error", on_lifecycle_error);
      detachers.push(() => {
        conversation.off("lifecycle_error", on_lifecycle_error);
      });

      const on_dispose = safely(() => {
        close_stream();
      });
      conversation.once("dispose", on_dispose);
      detachers.push(() => {
        conversation.off("dispose", on_dispose);
      });

      const cancel_conversation = () => {
        try {
          conversation.cancel_response();
        } catch {
          /* best effort */
        }
      };

      const signal = options.abort_signal;
      if (signal) {
        const on_abort = () => {
          if (closed) {
            return;
          }
          cancel_conversation();
          close_stream();
        };
        if (signal.aborted) {
          on_abort();
        } else {
          signal.addEventListener("abort", on_abort, { once: true });
          detachers.push(() => {
            signal.removeEventListener("abort", on_abort);
          });
        }
      }

      const timeout_ms = options.timeout_ms;
      if (timeout_ms !== null && timeout_ms !== undefined && timeout_ms > 0) {
        const handle = setTimeout(() => {
          if (closed) {
            return;
          }
          const wire_error = serialize_error(
            new Error(`encode_conversation: timed out after ${timeout_ms}ms`),
            include_stack,
          );
          // Encoder-internal lifecycle errors are always emitted,
          // regardless of the user's `events` set.
          enqueue({
            type: "lifecycle_error",
            data: { operation: "encoder_timeout", error: wire_error },
          });
          cancel_conversation();
          close_stream();
        }, timeout_ms);
        // Don't pin the Node event loop on a slow consumer.
        (handle as unknown as { unref?: () => void }).unref?.();
        detachers.push(() => {
          clearTimeout(handle);
        });
      }
    },
    cancel() {
      if (closed) {
        return;
      }
      closed = true;
      for (const d of detachers) {
        d();
      }
      try {
        conversation.cancel_response();
      } catch {
        /* not currently responding */
      }
    },
  });
}
