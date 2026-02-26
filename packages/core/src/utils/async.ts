import EventEmitter from "node:events";

/**
 * Token for monitoring and responding to cancellation requests.
 *
 * Provides a way to check if an operation has been cancelled and to
 * register callbacks for when cancellation occurs.
 */
export class CancellationToken {
  readonly #source?: CancellationTokenSource;

  /**
   * Creates a new cancellation token.
   *
   * @param source - Optional source that controls this token.
   */
  constructor(source?: CancellationTokenSource) {
    this.#source = source;
  }

  /**
   * Whether cancellation has been requested.
   */
  get is_cancellation_requested() {
    return !!this.#source?.is_cancelled;
  }

  /**
   * Registers a one-time handler for cancellation.
   *
   * @param event - The event name (always "cancel").
   * @param handler - The callback to invoke when cancelled.
   */
  once(event: "cancel", handler: () => void) {
    this.#source?.once(event, handler);
  }

  /**
   * Removes a cancellation handler.
   *
   * @param event - The event name (always "cancel").
   * @param handler - The callback to remove.
   */
  off(event: "cancel", handler: () => void) {
    this.#source?.off(event, handler);
  }

  /**
   * Throws an error if cancellation has been requested.
   */
  throw_if_cancellation_requested() {
    if (this.is_cancellation_requested) {
      throw new OperationCanceledError(this);
    }
  }

  /**
   * Creates a promise that rejects when cancellation is requested.
   *
   * @returns A promise that never resolves but rejects on cancellation.
   */
  await_cancellation() {
    return new Promise<never>((_, reject) =>
      this.once("cancel", () => reject(new OperationCanceledError(this))),
    );
  }

  /**
   * Creates an empty cancellation token that can never be cancelled.
   *
   * @returns A new cancellation token with no source.
   */
  static empty() {
    return new CancellationToken();
  }
}

/**
 * Source for creating and controlling cancellation tokens.
 *
 * Allows triggering cancellation for associated tokens.
 */
export class CancellationTokenSource {
  readonly #event_emitter = new EventEmitter();

  #is_cancelled = false;
  #is_disposed = false;
  #token?: CancellationToken;

  /**
   * Disposes the cancellation token source.
   *
   * This method is called automatically when using the `using` keyword.
   */
  [Symbol.dispose]() {
    if (this.#is_disposed) {
      throw new Error("invalid state");
    }
    this.#is_disposed = true;
    this.#event_emitter.removeAllListeners();
  }

  /**
   * Gets a cancellation token associated with this source.
   */
  get token() {
    if (!this.#token) {
      this.#token = new CancellationToken(this);
    }
    return this.#token;
  }

  /**
   * Whether cancellation has been triggered.
   */
  get is_cancelled() {
    return this.#is_cancelled;
  }

  /**
   * Registers a one-time handler for cancellation.
   *
   * @param event - The event name (always "cancel").
   * @param handler - The callback to invoke when cancelled.
   */
  once(event: "cancel", handler: () => void) {
    if (this.#is_cancelled) {
      throw new OperationCanceledError(new CancellationToken(this));
    }
    if (this.#is_disposed) {
      throw new Error("invalid state");
    }
    this.#event_emitter.once(event, handler);
  }

  /**
   * Removes a cancellation handler.
   *
   * @param event - The event name (always "cancel").
   * @param handler - The callback to remove.
   */
  off(event: "cancel", handler: () => void) {
    this.#event_emitter.off(event, handler);
  }

  /**
   * Triggers cancellation for all associated tokens.
   */
  cancel() {
    if (this.#is_cancelled) {
      throw new OperationCanceledError(new CancellationToken(this));
    }
    this.#is_cancelled = true;
    this.#event_emitter.emit("cancel");
  }
}

/**
 * Error thrown when an operation is cancelled.
 */
export class OperationCanceledError extends Error {
  readonly #token: CancellationToken;

  /**
   * Creates a new operation cancelled error.
   *
   * @param token - The cancellation token associated with this error.
   */
  constructor(token: CancellationToken) {
    super("The operation was cancelled", { cause: "cancelled" });
    this.#token = token;
  }

  /**
   * The cancellation token associated with this error.
   */
  get token() {
    return this.#token;
  }
}

/**
 * Delays execution for a specified time period with cancellation support.
 *
 * @param ms - The number of milliseconds to sleep.
 * @param cancellation_token - Optional token for cancelling the sleep.
 * @returns A promise that resolves after the delay or rejects if cancelled.
 */
export function sleep(ms: number, cancellation_token?: CancellationToken): Promise<void> {
  return new Promise((resolve, reject) => {
    if (cancellation_token) {
      const token = cancellation_token;
      const on_cancel = () => {
        clearTimeout(timeout);
        reject(new OperationCanceledError(token));
      };
      const on_timeout = () => {
        token.off("cancel", on_cancel);
        resolve();
      };
      const timeout = setTimeout(on_timeout, ms);
      if (token.is_cancellation_requested) {
        clearTimeout(timeout);
        reject(new OperationCanceledError(token));
      } else {
        token.once("cancel", on_cancel);
      }
    } else {
      setTimeout(resolve, ms);
    }
  });
}

/**
 * Peeks at the first value from an async generator without consuming it.
 *
 * @template T - The type of values yielded by the generator.
 * @param generator - The async generator to peek.
 * @returns An object containing the peeked value and a new generator that includes it.
 */
export async function peek_generator<T>(generator: AsyncGenerator<T>) {
  const iterator = generator[Symbol.asyncIterator]();

  let result = await iterator.next();

  const wrapper = (async function* () {
    while (true) {
      if (result.done) {
        break;
      }
      yield result.value;
      result = await iterator.next();
    }
  })();

  return {
    peeked_value: result.value as T,
    generator: wrapper,
  };
}
