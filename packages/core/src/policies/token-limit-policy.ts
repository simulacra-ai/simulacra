import {
  Conversation,
  ConversationEvents,
  FullMessageCompletionEvent,
} from "../conversations/index.ts";
import { CancellationToken, sleep } from "../utils/async.ts";
import { Policy, PolicyResult } from "./types.ts";

/**
 * Record of token usage for a single request.
 */
export interface TokenRecord {
  /** When this usage occurred. */
  timestamp: number;
  /** Number of input tokens consumed. */
  input_tokens: number;
  /** Number of output tokens generated. */
  output_tokens: number;
}

/**
 * Base options for token limit policy.
 */
type BaseOptions = {
  /** Time period in milliseconds for the token budget. */
  period_ms: number;
};

/**
 * Options for separate input and output token limits.
 */
type InputOutputTokenOptions = {
  /** Maximum input tokens allowed per period. */
  input_tokens_per_period: number;
  /** Maximum output tokens allowed per period. */
  output_tokens_per_period: number;
};

/**
 * Options for a combined total token limit.
 */
type TotalTokenOptions = {
  /** Maximum total tokens (input + output) allowed per period. */
  total_tokens_per_period: number;
};

/**
 * Configuration options for token limit policy.
 *
 * Can specify either separate input/output limits or a combined total limit.
 */
export type TokenLimitPolicyOptions = BaseOptions & (InputOutputTokenOptions | TotalTokenOptions);

/**
 * Policy that enforces token usage limits over a time period.
 *
 * Tracks token consumption and delays execution when limits are exceeded.
 */
export class TokenLimitPolicy extends Policy {
  readonly #options: TokenLimitPolicyOptions;

  #usage: TokenRecord[] = [];

  /**
   * Creates a new token limit policy.
   *
   * @param options - The token limit configuration.
   */
  constructor(options: TokenLimitPolicyOptions) {
    super();
    this.#options = options;
  }

  /**
   * Executes a function with token limit enforcement applied.
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
    this.#usage = this.#usage.filter((record) => now - record.timestamp < this.#options.period_ms);

    const input_tokens = this.#usage.reduce((sum, record) => sum + record.input_tokens, 0);
    const output_tokens = this.#usage.reduce((sum, record) => sum + record.output_tokens, 0);
    const total_tokens = input_tokens + output_tokens;

    let wait_time: number;

    const options = this.#options;

    if ("total_tokens_per_period" in options) {
      const total_token_wait_time = this.#calculate_wait_time(
        total_tokens,
        options.total_tokens_per_period,
      );
      wait_time = total_token_wait_time;
    } else {
      const input_token_wait_time = this.#calculate_wait_time(
        input_tokens,
        options.input_tokens_per_period,
      );
      const output_token_wait_time = this.#calculate_wait_time(
        output_tokens,
        options.output_tokens_per_period,
      );
      wait_time = Math.max(input_token_wait_time, output_token_wait_time);
    }

    const metadata: Record<string | symbol, unknown> = {
      policy: TokenLimitPolicy.name,
      ...this.#options,
      current_period_start: now - this.#options.period_ms,
      current_period_end: now,
      input_tokens,
      output_tokens,
      total_tokens,
      wait_time,
      recent_usage_count: this.#usage.length,
      recent_usage: this.#usage,
    };

    if ("total_tokens_per_period" in options) {
      metadata.total_token_wait_time = wait_time;
    } else {
      metadata.input_token_wait_time = this.#calculate_wait_time(
        input_tokens,
        options.input_tokens_per_period,
      );
      metadata.output_token_wait_time = this.#calculate_wait_time(
        output_tokens,
        options.output_tokens_per_period,
      );
    }

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
        error,
        metadata,
      };
    }
  }

  /**
   * Attaches this policy to a conversation to track its token usage.
   *
   * @param conversation - The conversation to monitor.
   */
  attach(conversation: Conversation) {
    conversation.on("message_complete", this.#on_message_complete);
    conversation.on("child_event", this.#on_child_event);
    conversation.once("dispose", () => {
      conversation.off("message_complete", this.#on_message_complete);
      conversation.off("child_event", this.#on_child_event);
    });
  }

  #on_message_complete = ({ usage }: FullMessageCompletionEvent) => {
    const input_tokens = usage?.input_tokens || 0;
    const output_tokens = usage?.output_tokens || 0;
    this.#usage.push({
      timestamp: Date.now(),
      input_tokens,
      output_tokens,
    });
  };

  #on_child_event = (event_data: ConversationEvents["child_event"][0]) => {
    const { event_name, event_args } = event_data;

    if (event_name === "message_complete") {
      const [event_data] = event_args;
      if (event_data) {
        this.#on_message_complete(event_data);
      }
    }

    if (event_name === "child_event") {
      const [child_event_data] = event_args;
      this.#on_child_event(child_event_data);
    }
  };

  #calculate_wait_time(current_tokens: number, tokens_per_period: number): number {
    if (current_tokens < tokens_per_period) {
      return 0;
    }
    const now = Date.now();
    const oldest = this.#usage[0];
    if (!oldest) {
      return 0;
    }
    return Math.max(0, oldest.timestamp + this.#options.period_ms - now);
  }
}
