import { EventEmitter } from "node:events";

import { Conversation } from "./conversation.ts";
import { ConversationEvents, Usage } from "./types.ts";

/**
 * Statistics about token usage.
 */
export interface TokenStats {
  /** Token usage from the most recent request. */
  last_request: {
    /** Input tokens in the last request. */
    input: number;
    /** Output tokens in the last request. */
    output: number;
  };
  /** Cumulative token usage across all requests. */
  total: {
    /** Total input tokens consumed. */
    input: number;
    /** Total output tokens generated. */
    output: number;
  };
}

/**
 * Events emitted by the TokenTracker.
 */
interface TokenTrackerEvents {
  /** Emitted when token statistics are updated. */
  stats_update: [TokenStats];
}

/**
 * Tracks token usage for a conversation and its children.
 *
 * Automatically monitors conversation events to accumulate token statistics.
 */
export class TokenTracker {
  readonly #event_emitter = new EventEmitter<TokenTrackerEvents>();
  readonly #conversation: Conversation;

  #stats: TokenStats = {
    last_request: {
      input: 0,
      output: 0,
    },
    total: {
      input: 0,
      output: 0,
    },
  };

  /**
   * Creates a new token tracker.
   *
   * @param conversation - The conversation to track.
   */
  constructor(conversation: Conversation) {
    this.#conversation = conversation;

    conversation.on("message_complete", this.#handle_event_with_usage);
    conversation.on("child_event", this.#handle_child_event);
  }

  /**
   * Disposes the token tracker and removes event listeners.
   *
   * This method is called automatically when using the `using` keyword.
   */
  [Symbol.dispose](): void {
    this.#conversation.off("message_complete", this.#handle_event_with_usage);
    this.#conversation.off("child_event", this.#handle_child_event);
    this.#event_emitter.removeAllListeners();
  }

  /**
   * The current token statistics.
   */
  public get stats(): Readonly<TokenStats> {
    return Object.freeze({ ...this.#stats });
  }

  /**
   * Registers an event listener for statistics updates.
   *
   * @param event - The event name (always "stats_update").
   * @param listener - The callback to invoke when statistics update.
   */
  public on(event: "stats_update", listener: (stats: TokenStats) => void): void {
    this.#event_emitter.on(event, listener);
  }

  /**
   * Removes an event listener for statistics updates.
   *
   * @param event - The event name (always "stats_update").
   * @param listener - The callback to remove.
   */
  public off(event: "stats_update", listener: (stats: TokenStats) => void): void {
    this.#event_emitter.off(event, listener);
  }

  #handle_event_with_usage = ({ usage }: { usage: Usage }) => {
    this.#process_usage(usage);
  };

  #handle_child_event = (event_data: ConversationEvents["child_event"][0]) => {
    const { event_name, event_args } = event_data;

    if (event_name === "message_complete") {
      const [event_data] = event_args;
      if (event_data && "usage" in event_data) {
        this.#process_usage(event_data.usage);
      }
    }

    if (event_name === "child_event") {
      const [child_event_data] = event_args;
      this.#handle_child_event(child_event_data);
    }
  };

  #process_usage = (usage: Usage) => {
    if (usage) {
      const input_tokens = usage.input_tokens || 0;
      const output_tokens = usage.output_tokens || 0;

      this.#stats = {
        last_request: {
          input: input_tokens,
          output: output_tokens,
        },
        total: {
          input: this.stats.total.input + input_tokens,
          output: this.stats.total.output + output_tokens,
        },
      };

      this.#event_emitter.emit("stats_update", this.stats);
    }
  };
}
