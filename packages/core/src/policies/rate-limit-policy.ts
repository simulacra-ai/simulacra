import { Conversation, ConversationEvents } from "../conversations/index.ts";
import { CancellationToken, sleep } from "../utils/async.ts";
import { Policy, PolicyResult } from "./types.ts";

/**
 * Configuration options for rate limiting.
 */
export type RateLimitPolicyOptions = {
  /** Maximum number of requests allowed in the time period. */
  limit: number;
  /** Time period in milliseconds. */
  period_ms: number;
};

/**
 * Policy that enforces rate limits on operations.
 *
 * Tracks request timestamps and delays execution when the rate limit is exceeded.
 */
export class RateLimitPolicy extends Policy {
  readonly #options: RateLimitPolicyOptions;

  #requests: number[] = [];

  /**
   * Creates a new rate limit policy.
   *
   * @param options - The rate limiting configuration.
   */
  constructor(options: RateLimitPolicyOptions) {
    super();
    this.#options = options;
  }

  /**
   * Attaches this policy to a conversation to track its requests.
   *
   * @param conversation - The conversation to monitor.
   */
  attach(conversation: Conversation) {
    conversation.on("request_success", this.#on_request_success);
    conversation.on("child_event", this.#on_child_event);
    conversation.once("dispose", () => {
      conversation.off("request_success", this.#on_request_success);
      conversation.off("child_event", this.#on_child_event);
    });
  }

  /**
   * Executes a function with rate limiting applied.
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
    const now = Date.now();

    this.#requests = this.#requests.filter(
      (timestamp) => now - timestamp < this.#options.period_ms,
    );

    const current_usage = this.#requests.length;

    const metadata: Record<string | symbol, unknown> = {
      policy: RateLimitPolicy.name,
      limit: this.#options.limit,
      period_ms: this.#options.period_ms,
      current_usage,
    };

    const wait_time = this.#calculate_wait_time(
      current_usage,
      this.#options.limit,
      this.#options.period_ms,
    );

    if (wait_time > 0) {
      metadata.wait_time_ms = wait_time;
      await sleep(wait_time, cancellation_token);
    }

    cancellation_token.throw_if_cancellation_requested();
    try {
      const value = await Promise.race([fn(...args), cancellation_token.await_cancellation()]);
      return {
        result: true,
        value,
        metadata,
      };
    } catch (error) {
      return {
        result: false,
        error: error as Error,
        metadata,
      };
    }
  }

  #calculate_wait_time(current_usage: number, limit: number, period_ms: number): number {
    if (current_usage < limit) {
      return 0;
    }
    const requests_over_limit = current_usage - limit + 1;
    const time_per_request = period_ms / limit;
    return requests_over_limit * time_per_request;
  }

  #on_request_success = () => {
    const now = Date.now();
    this.#requests.push(now);
  };

  #on_child_event = (event_data: ConversationEvents["child_event"][0]) => {
    const { event_name, event_args } = event_data;

    if (event_name === "request_success") {
      this.#on_request_success();
    }

    if (event_name === "child_event") {
      const [child_event_data] = event_args;
      this.#on_child_event(child_event_data);
    }
  };
}
