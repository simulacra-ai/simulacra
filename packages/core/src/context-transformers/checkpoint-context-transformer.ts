import type { AssistantMessage, Message } from "../conversations/index.ts";
import type { ContextTransformer, TransformContext } from "./types.ts";

/**
 * Context transformer that trims pre-checkpoint messages and inserts
 * the checkpoint summary as a synthetic first user message. The boundary
 * message (an assistant response) is retained as the natural response to
 * the summary, maintaining proper message alternation.
 */
export class CheckpointContextTransformer implements ContextTransformer {
  /**
   * Replaces all messages before the checkpoint boundary with a synthetic user
   * message containing the checkpoint summary. Messages after the boundary are
   * kept intact. Returns messages unchanged if no checkpoint is active.
   */
  async transform_prompt(messages: Message[], context?: TransformContext): Promise<Message[]> {
    const checkpoint = context?.checkpoint;
    if (!checkpoint) {
      return messages;
    }

    const boundary = messages.findIndex((m) => m.id === checkpoint.message_id);
    if (boundary === -1) {
      return messages;
    }

    const summary_message: Message = {
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", timestamp: Date.now(), text: checkpoint.summary }],
    };

    const boundary_message = messages[boundary];
    if (boundary_message.role === "user") {
      return [summary_message, ...messages.slice(boundary + 1)];
    }
    return [summary_message, ...messages.slice(boundary)];
  }

  /** No-op. Returns the message unchanged. */
  transform_completion(message: AssistantMessage): Promise<AssistantMessage> {
    return Promise.resolve(message);
  }
}
