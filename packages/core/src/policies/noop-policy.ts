import { CancellationToken } from "../utils/async.ts";
import { Policy, PolicyResult } from "./types.ts";

/**
 * Policy that performs no special operations.
 *
 * Simply executes the provided function with cancellation support.
 */
export class NoopPolicy extends Policy {
  /**
   * Executes a function with no additional policy logic.
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
    try {
      cancellation_token.throw_if_cancellation_requested();
      return {
        result: true,
        value: await Promise.race([fn(...args), cancellation_token.await_cancellation()]),
        metadata: { policy: NoopPolicy.name },
      };
    } catch (error) {
      return {
        result: false,
        error,
        metadata: { policy: NoopPolicy.name },
      };
    }
  }
}
