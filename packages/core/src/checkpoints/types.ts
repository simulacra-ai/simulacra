import type { Message } from "../conversations/types.ts";
import type { CheckpointState } from "../context-transformers/types.ts";

/**
 * Configuration for a checkpoint operation.
 */
export interface CheckpointConfig {
  /** Arbitrary context passed through to the prompt strategy. */
  context?: Record<string, unknown>;
}

/**
 * Strategy for generating a checkpoint summary of a conversation.
 */
export interface SummarizationStrategy {
  /** Builds the messages for the checkpoint conversation from the parent's context. */
  build_prompt(context: SummarizationContext): Message[];
}

/**
 * Context provided to the summarization strategy.
 */
export interface SummarizationContext {
  /** The session ID of the conversation being checkpointed. */
  session_id: string;
  /** The conversation messages since the last checkpoint (or all if first checkpoint). */
  messages: readonly Message[];
  /** The previous checkpoint state, if this is an incremental checkpoint. */
  previous_checkpoint?: CheckpointState;
  /** The system prompt of the conversation being checkpointed. */
  system?: string;
  /** Arbitrary context forwarded from CheckpointConfig. */
  context?: Record<string, unknown>;
}
