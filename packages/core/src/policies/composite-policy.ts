import { CancellationToken } from "../utils/async.ts";
import { NoopPolicy } from "./noop-policy.ts";
import { Policy, PolicyResult } from "./types.ts";

/**
 * Policy that combines multiple policies into a single execution chain.
 *
 * Policies are applied in the order provided, with each policy wrapping
 * the execution of the next.
 */
export class CompositePolicy extends Policy {
  readonly #policies: Policy[];

  /**
   * Creates a new composite policy.
   *
   * @param policies - The policies to compose. If empty, uses a NoopPolicy.
   */
  constructor(...policies: Policy[]) {
    super();
    this.#policies = policies.length > 0 ? policies : [new NoopPolicy()];
  }

  /**
   * Executes a function with all composed policies applied.
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
    let current_fn = fn;
    const policy_metadata: Record<string, unknown> = {};
    const execution_order: string[] = [];

    for (let i = this.#policies.length - 1; i >= 0; i--) {
      cancellation_token.throw_if_cancellation_requested();

      const policy = this.#policies[i];
      const policy_name = `${policy.constructor.name}[${i}]`;
      execution_order.push(policy_name);

      const wrapped_fn = current_fn;
      current_fn = async (...wrapped_args: TArgs) => {
        const policy_result = await policy.execute(cancellation_token, wrapped_fn, ...wrapped_args);
        policy_metadata[policy_name] = policy_result.metadata;

        if (policy_result.result) {
          return policy_result.value;
        } else {
          throw policy_result.error;
        }
      };
    }

    try {
      return {
        result: true,
        value: await current_fn(...args),
        metadata: {
          policy: CompositePolicy.name,
          policies: policy_metadata,
          execution_order: [...execution_order].reverse(),
          policy_count: this.#policies.length,
        },
      };
    } catch (error) {
      return {
        result: false,
        error,
        metadata: {
          policy: CompositePolicy.name,
          policies: policy_metadata,
          execution_order: [...execution_order].reverse(),
          policy_count: this.#policies.length,
        },
      };
    }
  }
}
