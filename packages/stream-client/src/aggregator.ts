import type { AssistantMessage, ToolContent } from "@simulacra-ai/core";
import type { WireEvent } from "@simulacra-ai/core";
import { rebuild_error } from "./rebuild-error.ts";

export interface ConversationResult {
  text: string;
  tool_calls: ToolContent[];
}

/**
 * Drain any `WireEvent` source (NDJSON-decoded, SSE-decoded, WebSocket
 * messages, etc.) into a single aggregated result. Throws on
 * `request_error` / `lifecycle_error`.
 */
export async function collect_conversation_result(
  events: AsyncIterable<WireEvent>,
): Promise<ConversationResult> {
  let final_message: AssistantMessage | undefined;

  for await (const event of events) {
    if (event.type === "message_complete") {
      // Defensive role check so a misbehaving server can't poison extraction.
      const msg = event.data.message;
      if (msg && (msg as { role?: string }).role === "assistant") {
        final_message = msg as AssistantMessage;
      }
    } else if (event.type === "request_error" || event.type === "lifecycle_error") {
      throw rebuild_error(event.data.error, event.type);
    }
  }

  let text = "";
  const tool_calls: ToolContent[] = [];
  if (final_message?.content) {
    for (const block of final_message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        text += block.text;
      } else if (block.type === "tool") {
        tool_calls.push(block);
      }
    }
  }

  return { text, tool_calls };
}
