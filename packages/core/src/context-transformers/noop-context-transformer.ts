import { AssistantMessage, Message } from "../conversations/index.ts";
import { ContextTransformer } from "./types.ts";

/**
 * Context transformer that performs no transformations.
 *
 * Returns messages unchanged.
 */
export class NoopContextTransformer implements ContextTransformer {
  /**
   * Returns the prompt messages unchanged.
   *
   * @param messages - The messages to pass through.
   * @returns A promise that resolves to the same messages.
   */
  transform_prompt(messages: Message[]): Promise<Message[]> {
    return Promise.resolve(messages);
  }

  /**
   * Returns the completion message unchanged.
   *
   * @param message - The assistant message to pass through.
   * @returns A promise that resolves to the same message.
   */
  transform_completion(message: AssistantMessage) {
    return Promise.resolve(message);
  }
}
