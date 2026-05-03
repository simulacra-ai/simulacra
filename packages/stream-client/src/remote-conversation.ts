import type { AssistantMessage, ToolContent } from "@simulacra-ai/core";
import type { WireEvent, WireEventType } from "@simulacra-ai/core";
import { rebuild_error } from "./rebuild-error.ts";
import type { ConversationResult } from "./aggregator.ts";

export type RemoteConversationListener<T extends WireEventType> = (
  data: Extract<WireEvent, { type: T }>["data"],
) => void;

export interface RemoteConversationConsumeOptions {
  abort_signal?: AbortSignal;
  /** Defaults to swallowing — pass a function to surface listener throws. */
  on_listener_error?: (error: unknown, event_type: WireEventType) => void;
}

/**
 * Client-side facade mirroring the event-bus surface of a local
 * `Conversation`, driven from any `WireEvent` source — NDJSON-decoded,
 * SSE-decoded, or WebSocket messages. Single-use.
 */
export class RemoteConversation {
  readonly #source: AsyncIterable<WireEvent>;
  readonly #listeners = new Map<WireEventType, Set<(data: unknown) => void>>();
  // Keyed by (type, original) so the same fn can be `once`d on multiple types.
  readonly #once_wrappers = new Map<
    WireEventType,
    Map<(data: unknown) => void, (data: unknown) => void>
  >();
  #consumed = false;

  constructor(source: AsyncIterable<WireEvent>) {
    this.#source = source;
  }

  on<T extends WireEventType>(type: T, listener: RemoteConversationListener<T>): this {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener as (data: unknown) => void);
    return this;
  }

  off<T extends WireEventType>(type: T, listener: RemoteConversationListener<T>): this {
    const original = listener as (data: unknown) => void;
    const type_wrappers = this.#once_wrappers.get(type);
    const wrapped = type_wrappers?.get(original);
    const target = wrapped ?? original;
    const set = this.#listeners.get(type);
    if (!set) {
      return this;
    }
    const removed = set.delete(target);
    if (removed && wrapped && type_wrappers) {
      type_wrappers.delete(original);
      if (type_wrappers.size === 0) {
        this.#once_wrappers.delete(type);
      }
    }
    return this;
  }

  once<T extends WireEventType>(type: T, listener: RemoteConversationListener<T>): this {
    const original = listener as (data: unknown) => void;
    const wrapped = (data: unknown): void => {
      const inner = this.#once_wrappers.get(type);
      if (inner) {
        inner.delete(original);
        if (inner.size === 0) {
          this.#once_wrappers.delete(type);
        }
      }
      const set = this.#listeners.get(type);
      if (set) {
        set.delete(wrapped);
      }
      original(data);
    };
    let type_wrappers = this.#once_wrappers.get(type);
    if (!type_wrappers) {
      type_wrappers = new Map();
      this.#once_wrappers.set(type, type_wrappers);
    }
    type_wrappers.set(original, wrapped);
    return this.on(type, wrapped as RemoteConversationListener<T>);
  }

  /**
   * Drain the source and return the aggregated result. Throws on
   * `request_error` / `lifecycle_error`. Listeners still fire for error
   * events before the throw.
   */
  async consume(options: RemoteConversationConsumeOptions = {}): Promise<ConversationResult> {
    if (this.#consumed) {
      throw new Error("RemoteConversation: already consumed");
    }
    this.#consumed = true;

    let final_message: AssistantMessage | undefined;
    let pending_error: Error | undefined;

    const on_listener_error = options.on_listener_error;
    const dispatch = (event: WireEvent) => {
      const set = this.#listeners.get(event.type);
      if (!set) {
        return;
      }
      // Snapshot so a listener calling .off mid-dispatch doesn't mutate iteration.
      for (const listener of [...set]) {
        try {
          listener(event.data);
        } catch (err) {
          if (on_listener_error) {
            try {
              on_listener_error(err, event.type);
            } catch {
              /* swallow */
            }
          }
        }
      }
    };

    const signal = options.abort_signal;

    let source_error: unknown;
    try {
      for await (const event of this.#source) {
        if (signal?.aborted) {
          break;
        }
        dispatch(event);

        if (event.type === "message_complete") {
          const msg = event.data.message;
          if (msg && (msg as { role?: string }).role === "assistant") {
            final_message = msg as AssistantMessage;
          }
        } else if (event.type === "request_error" || event.type === "lifecycle_error") {
          // Capture first error; let any subsequent events still dispatch.
          if (!pending_error) {
            pending_error = rebuild_error(event.data.error, event.type);
          }
        }
      }
    } catch (err) {
      source_error = err;
    }

    if (signal?.aborted) {
      const reason = signal.reason;
      if (reason instanceof Error) {
        throw reason;
      }
      throw new Error(
        reason === undefined
          ? "RemoteConversation: aborted"
          : `RemoteConversation: aborted (${String(reason)})`,
      );
    }
    if (pending_error) {
      throw pending_error;
    }
    if (source_error) {
      throw source_error;
    }

    let text = "";
    const tool_calls: ToolContent[] = [];
    if (final_message?.content) {
      for (const block of final_message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
        } else if (block.type === "tool") {
          tool_calls.push(block);
        }
      }
    }

    return { text, tool_calls };
  }
}
