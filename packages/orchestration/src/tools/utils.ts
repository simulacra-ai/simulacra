import type { SubagentResult } from "../types.ts";

/**
 * Extract the final text response from a subagent result.
 *
 * @param result - The completed subagent result.
 */
export function extract_response(result: SubagentResult): string {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const message = result.messages[i];
    if (message.role !== "assistant") {
      continue;
    }
    const content = message.content;
    if (!content) {
      continue;
    }
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (block.type === "text" && block.text) {
        return block.text;
      }
    }
  }
  return "(no text response)";
}
