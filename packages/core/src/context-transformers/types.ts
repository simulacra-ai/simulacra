import { AssistantMessage, Message } from "../conversations/index.ts";

/**
 * The active checkpoint state for a conversation.
 */
export interface CheckpointState {
  /** The ID of the last message included in the checkpoint. */
  message_id: string;
  /** The condensed summary produced by the checkpoint model call. */
  summary: string;
}

/**
 * Additional context passed to transformers alongside messages.
 */
export interface TransformContext {
  /** The active checkpoint, if any. */
  checkpoint?: CheckpointState;
}

/**
 * Interface for transforming conversation context before and after model requests.
 *
 * Context transformers can modify messages before they are sent to the model
 * and transform assistant responses before they are added to conversation history.
 */
export interface ContextTransformer {
  /**
   * Transforms the prompt messages before sending to the model.
   *
   * @param messages - The messages to transform.
   * @param context - Additional context such as checkpoint state.
   * @returns A promise that resolves to the transformed messages.
   */
  transform_prompt(messages: Message[], context?: TransformContext): Promise<Message[]>;

  /**
   * Transforms the assistant's completion message before adding to history.
   *
   * @param message - The assistant message to transform.
   * @returns A promise that resolves to the transformed message.
   */
  transform_completion(message: AssistantMessage): Promise<AssistantMessage>;
}

/**
 * Interface for provider-level context transformers.
 *
 * Provider transformers normalize provider-specific quirks at the wire level.
 * They run before conversation-level transformers and do not receive
 * conversation context (checkpoints, etc.). Both methods are optional —
 * most provider transformers only need one direction.
 */
export interface ProviderContextTransformer {
  /**
   * Transforms prompt messages before sending to the model.
   *
   * @param messages - The messages to transform.
   * @returns A promise that resolves to the transformed messages.
   */
  transform_prompt?(messages: Message[]): Promise<Message[]>;

  /**
   * Transforms the assistant's completion message before adding to history.
   *
   * @param message - The assistant message to transform.
   * @returns A promise that resolves to the transformed message.
   */
  transform_completion?(message: AssistantMessage): Promise<AssistantMessage>;
}
