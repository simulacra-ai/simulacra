import { CancellationToken } from "../utils/async.ts";

/**
 * Represents a successful policy execution.
 *
 * @template T - The type of the result value.
 */
export interface PolicySuccessResult<T> {
  result: true;
  /** Metadata about the policy execution. */
  metadata: object;
  /** The value returned by the wrapped function. */
  value: T;
}

/**
 * Represents a failed policy execution.
 */
export interface PolicyErrorResult {
  result: false;
  /** Metadata about the policy execution. */
  metadata: object;
  /** The error that occurred. */
  error: unknown;
}

/**
 * Union of all possible policy execution results.
 *
 * @template T - The type of the success result value.
 */
export type PolicyResult<T> = PolicySuccessResult<T> | PolicyErrorResult;

/**
 * Base class for all policies.
 *
 * Policies wrap function execution to provide cross-cutting concerns like
 * retries, rate limiting, and token budget management.
 */
export abstract class Policy {
  /**
   * Executes a function with this policy applied.
   *
   * @template TResult - The return type of the function.
   * @template TArgs - The argument types of the function.
   * @param cancellation_token - Token for cancelling the operation.
   * @param fn - The function to execute.
   * @param args - Arguments to pass to the function.
   * @returns A promise that resolves to the policy result.
   */
  abstract execute<TResult, TArgs extends unknown[]>(
    cancellation_token: CancellationToken,
    fn: (...args: TArgs) => Promise<TResult>,
    ...args: TArgs
  ): Promise<PolicyResult<TResult>>;
}
