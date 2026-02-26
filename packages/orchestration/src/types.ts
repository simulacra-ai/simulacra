import type { Message, ToolClass, Workflow } from "@simulacra-ai/core";

/**
 * Configuration options for spawning a subagent.
 */
export interface SubagentOptions {
  /**
   * The system prompt for the subagent's conversation.
   */
  system?: string;
  /**
   * The tools available to the subagent.
   */
  toolkit?: ToolClass[];
  /**
   * Whether the subagent starts with a copy of the parent's conversation history.
   */
  fork_session?: boolean;
  /**
   * A custom identifier for the subagent.
   */
  id?: string;
}

/**
 * The result of a completed subagent execution.
 */
export interface SubagentResult {
  /**
   * The unique identifier of the subagent.
   */
  id: string;
  /**
   * The complete message history from the subagent's conversation.
   */
  messages: readonly Readonly<Message>[];
  /**
   * The reason the subagent's execution ended.
   */
  end_reason: "complete" | "cancel" | "error";
}

/**
 * A handle for managing a background subagent task.
 */
export interface BackgroundHandle {
  /**
   * The unique identifier of the background task.
   */
  readonly id: string;
  /**
   * The workflow instance running the background task.
   */
  readonly workflow: Workflow;
  /**
   * A promise that resolves when the background task completes.
   */
  readonly promise: Promise<SubagentResult>;
  /**
   * Whether the background task has finished execution.
   */
  readonly done: boolean;
  /**
   * Cancels the background task.
   */
  cancel(): void;
}

/**
 * Status snapshot of a background worker.
 */
export interface WorkerState {
  /**
   * The unique identifier of the worker.
   */
  id: string;
  /**
   * The worker's current execution state.
   */
  status: "running" | "completed" | "cancelled";
  /**
   * Number of agentic turns (assistant messages) completed.
   */
  rounds: number;
  /**
   * Total number of tool calls made across all rounds.
   */
  tool_call_count: number;
  /**
   * The text content of the most recent assistant message, if any.
   */
  latest_message?: string;
}
