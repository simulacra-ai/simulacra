import { CancellationToken, sleep } from "../utils/async.ts";
import { Policy, PolicyErrorResult, PolicyResult } from "./types.ts";

/**
 * Configuration options for retry behavior.
 */
export interface RetryPolicyOptions {
  /** Maximum number of attempts (including the initial attempt). */
  max_attempts: number;
  /** Initial backoff delay in milliseconds. */
  initial_backoff_ms: number;
  /** Factor by which to multiply the backoff after each retry. */
  backoff_factor: number;
  /** Optional function to determine if an error is retryable. */
  retryable?: (result: PolicyErrorResult) => boolean;
}

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529]);

export function defaultRetryable(result: PolicyErrorResult): boolean {
  const error = result.error;

  if (error !== null && error !== undefined && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number") {
      return RETRYABLE_HTTP_STATUS_CODES.has(status);
    }
  }

  if (error !== null && error !== undefined && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_NETWORK_ERROR_CODES.has(code)) {
      return true;
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== null && cause !== undefined && typeof cause === "object") {
      const causeCode = (cause as { code?: unknown }).code;
      if (typeof causeCode === "string" && RETRYABLE_NETWORK_ERROR_CODES.has(causeCode)) {
        return true;
      }
    }
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("socket hang up") ||
      msg.includes("network error") ||
      msg.includes("fetch failed")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Policy that retries failed operations with exponential backoff.
 *
 * @template _TResult - The result type of the operation.
 */
export class RetryPolicy<_TResult> extends Policy {
  readonly #options: Required<RetryPolicyOptions>;

  /**
   * Creates a new retry policy.
   *
   * @param options - The retry configuration options.
   */
  constructor(options: RetryPolicyOptions) {
    super();
    this.#options = { ...options, retryable: options.retryable ?? defaultRetryable };
  }

  /**
   * Executes a function with retry logic applied.
   *
   * @template TResult - The return type of the function.
   * @template TArgs - The argument types of the function.
   * @param cancellation_token - Token for cancelling the operation.
   * @param fn - The function to execute.
   * @param args - Arguments to pass to the function.
   * @returns A promise that resolves to the policy result.
   */
  async execute<TResult, TArgs extends unknown[]>(
    cancellation_token: CancellationToken,
    fn: (...args: TArgs) => Promise<TResult>,
    ...args: TArgs
  ): Promise<PolicyResult<TResult>> {
    let attempt = 1;
    let backoff_ms = this.#options.initial_backoff_ms;
    const metadata: Record<string | symbol, unknown> = {
      policy: RetryPolicy.name,
      attempts: 0,
      ...this.#options,
    };

    while (true) {
      cancellation_token.throw_if_cancellation_requested();
      try {
        const value = await Promise.race([fn(...args), cancellation_token.await_cancellation()]);
        metadata.attempts = attempt;

        return {
          result: true,
          value,
          metadata,
        };
      } catch (error) {
        metadata.attempts = attempt;

        const result: PolicyErrorResult = {
          result: false,
          error,
          metadata,
        };
        if (attempt >= this.#options.max_attempts || !this.#options.retryable(result)) {
          return result;
        }

        await sleep(backoff_ms, cancellation_token);

        metadata.lastError = error;
        metadata.lastBackoffMs = backoff_ms;

        backoff_ms *= this.#options.backoff_factor;
        attempt++;
      }
    }
  }
}
