import type { Message } from "../conversations/types.ts";
import type { SummarizationContext, SummarizationStrategy } from "./types.ts";

/**
 * Default summarization strategy for checkpoints.
 *
 * Serializes the conversation context into a structured text block and appends
 * an instruction asking the model to produce a condensed summary.
 */
export class DefaultSummarizationStrategy implements SummarizationStrategy {
  /**
   * Builds the summarization prompt from the conversation context. Assembles
   * the previous checkpoint summary, system prompt, and recent messages into a
   * structured text block, then appends instructions asking the model to produce
   * a condensed summary suitable for continuing the conversation.
   */
  build_prompt(context: SummarizationContext): Message[] {
    const sections: string[] = [];

    if (context.previous_checkpoint) {
      sections.push(`## Previous Checkpoint Summary\n${context.previous_checkpoint.summary}`);
    }

    if (context.system) {
      sections.push(`## System Prompt\n${context.system}`);
    }

    if (context.messages.length > 0) {
      sections.push(`## Conversation\n${this.#serialize_messages(context.messages)}`);
    }

    sections.push(
      [
        "## Instructions",
        "Summarize the above conversation concisely. Preserve:",
        "- Key decisions and their rationale",
        "- Current state of any in-progress work",
        "- Important facts, names, and values established",
        "- Tool outcomes",
        "- Any explicit user preferences or instructions",
        "",
        "Omit redundant back-and-forth and superseded plans.",
        "Format as a structured briefing the model can use to continue the conversation seamlessly.",
      ].join("\n"),
    );

    return [
      {
        role: "user",
        content: [{ type: "text", text: sections.join("\n\n") }],
      },
    ];
  }

  #serialize_messages(messages: readonly Message[]): string {
    return messages
      .map((m) => {
        const role = m.role === "user" ? "User" : "Assistant";
        const parts = m.content
          .map((c) => {
            switch (c.type) {
              case "text":
                return c.text;
              case "thinking":
                return `[Thinking: ${c.thought}]`;
              case "tool":
                return `[Called tool: ${c.tool}]`;
              case "tool_result":
                return `[Tool ${c.tool} returned: ${JSON.stringify(c.result)}]`;
              default:
                return undefined;
            }
          })
          .filter(Boolean);
        return `${role}: ${parts.join("\n")}`;
      })
      .join("\n\n");
  }
}
