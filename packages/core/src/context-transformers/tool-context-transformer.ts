import { AssistantMessage, Message } from "../conversations/index.ts";
import { ContextTransformer } from "./types.ts";

/**
 * Context transformer that removes unreferenced tool invocations from message history.
 *
 * Filters out tool content blocks that don't have a corresponding tool_result,
 * reducing context size when tools were invoked but their results are no longer
 * relevant to the conversation.
 */
export class ToolContextTransformer implements ContextTransformer {
  /**
   * Transforms prompt messages by removing unreferenced tool invocations.
   *
   * @param messages - The messages to transform.
   * @returns A promise that resolves to the transformed messages.
   */
  transform_prompt(messages: Message[]) {
    const tool_ids: string[] = [];
    const message_context: Message[] = [];

    for (const message of messages.toReversed()) {
      tool_ids.push(
        ...message.content.filter((c) => c.type === "tool_result").map((c) => c.tool_request_id),
      );
      const cleaned_message = {
        ...message,
        content: message.content.filter(
          (c) => c.type !== "tool" || tool_ids.includes(c.tool_request_id),
        ),
      };
      if (cleaned_message.content.length) {
        message_context.unshift(cleaned_message as Message);
      } else if (message.role === "assistant") {
        message_context.unshift({
          ...message,
          content: [{ type: "text", text: "" }],
        } as Message);
      } else if (message.role === "user") {
        message_context.unshift({
          ...message,
          content: [{ type: "text", text: "" }],
        } as Message);
      }
    }
    return Promise.resolve(message_context);
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
