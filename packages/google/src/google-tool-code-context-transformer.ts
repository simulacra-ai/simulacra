import crypto from "node:crypto";

import type {
  AssistantContent,
  AssistantMessage,
  ProviderContextTransformer,
  TextContent,
  ToolContent,
} from "@simulacra-ai/core";

/**
 * Provider context transformer that extracts tool calls from Gemini's code execution blocks.
 *
 * Gemini models sometimes return tool calls as executable code in markdown code blocks
 * tagged with "tool_code". This transformer parses those blocks and converts them into
 * standard tool call content that the framework can execute.
 */
export class GoogleToolCodeContextTransformer implements ProviderContextTransformer {
  /**
   * Transforms completion messages by extracting tool calls from code blocks.
   *
   * Scans text content for code blocks tagged as "tool_code" and parses them into
   * proper tool call content. The original code blocks are replaced with newlines
   * in the text content.
   *
   * @param message - The completion message to transform.
   * @returns A promise resolving to the transformed message.
   */
  transform_completion(message: AssistantMessage) {
    if (message.role !== "assistant") {
      return Promise.resolve(message);
    }

    return Promise.resolve({
      ...message,
      content: message.content.flatMap((c) => {
        if (c.type !== "text") {
          return [c];
        }
        return this.extract_tool_calls(c);
      }),
    });
  }

  private extract_tool_calls(content: TextContent) {
    const tool_calls: ToolContent[] = [];
    const remaining_text = content.text.replaceAll(
      /```(?:tool_code)\n(.*?)\n```/gs,
      (_, tool_code) => {
        const tool_call = this.parse_tool_call(content, tool_code);
        if (tool_call) {
          tool_calls.push(tool_call);
        }
        return "\n";
      },
    );

    return [{ ...content, text: remaining_text }, ...tool_calls] as AssistantContent[];
  }

  private parse_tool_call(content: AssistantContent, tool_code?: string) {
    const function_match = tool_code?.match(/^print\((\w+)\((.*)\)\)$/);
    if (!function_match) {
      return;
    }
    const [_, name, params_text] = function_match;
    const params = Object.fromEntries(
      Array.from(
        params_text.matchAll(
          /(\w+)\s*=\s*(("(?:\\"|[^"])*")|(-?[\d.]+)|([Tt]rue|[Ff]alse))\s*(,|$)/g,
        ),
      ).map(([_match, key, _full, str, num, bool]: string[]) => {
        if (bool !== undefined) {
          return [key, bool.toLocaleLowerCase() === "true"];
        }
        if (!isNaN(Number(num))) {
          return [key, Number(num)];
        }
        try {
          return [key, JSON.parse(str)];
        } catch {
          return [key, str];
        }
      }),
    );

    return {
      type: "tool",
      tool_request_id: content.id ?? crypto.randomUUID(),
      tool: name,
      params: params,
    } as ToolContent;
  }
}
