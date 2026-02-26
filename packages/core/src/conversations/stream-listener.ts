import { StreamReceiver } from "./types.ts";

/**
 * Discriminated union of all possible stream events and their payloads.
 */
export type StreamListenerPayload = {
  [E in keyof StreamReceiver]: {
    event: E;
    payload: Parameters<StreamReceiver[E]>;
  };
}[keyof StreamReceiver];

/**
 * Internal utility for converting StreamReceiver callbacks into a single event handler.
 *
 * This class is used internally by Conversation to manage streaming events.
 */
export class StreamListener {
  readonly #listener: (payload: StreamListenerPayload) => void | Promise<void>;

  #is_disposed = false;

  /**
   * Creates a new stream listener.
   *
   * @param listener - The callback to invoke with stream events.
   */
  constructor(listener: (payload: StreamListenerPayload) => void | Promise<void>) {
    this.#listener = listener;
  }

  /**
   * Disposes the stream listener.
   *
   * This method is called automatically when using the `using` keyword.
   */
  [Symbol.dispose]() {
    this.#is_disposed = true;
  }

  /**
   * Creates a StreamReceiver that forwards all events to the listener.
   *
   * @returns A new stream receiver instance.
   */
  create_receiver() {
    const receiver: StreamReceiver = {
      start_message: (...args) => this.#receive({ event: "start_message", payload: args }),
      update_message: (...args) => this.#receive({ event: "update_message", payload: args }),
      complete_message: (...args) => this.#receive({ event: "complete_message", payload: args }),
      start_content: (...args) => this.#receive({ event: "start_content", payload: args }),
      update_content: (...args) => this.#receive({ event: "update_content", payload: args }),
      complete_content: (...args) => this.#receive({ event: "complete_content", payload: args }),
      error: (...args) => this.#receive({ event: "error", payload: args }),
      before_request: (...args) => this.#receive({ event: "before_request", payload: args }),
      request_raw: (...args) => this.#receive({ event: "request_raw", payload: args }),
      response_raw: (...args) => this.#receive({ event: "response_raw", payload: args }),
      stream_raw: (...args) => this.#receive({ event: "stream_raw", payload: args }),
      cancel: (...args) => this.#receive({ event: "cancel", payload: args }),
    };
    return receiver;
  }

  #receive = (payload: StreamListenerPayload) => {
    if (this.#is_disposed) {
      return;
    }
    try {
      const result = this.#listener(payload);
      if (result && typeof result === "object" && "catch" in result) {
        (result as Promise<void>).catch((error) => {
          if (!this.#is_disposed && payload.event !== "error") {
            this.#listener({ event: "error", payload: [error] });
          }
        });
      }
    } catch (error) {
      if (!this.#is_disposed && payload.event !== "error") {
        this.#listener({ event: "error", payload: [error] });
      }
    }
  };
}
