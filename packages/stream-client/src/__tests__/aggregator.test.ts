import { describe, expect, it } from "vitest";
import type { WireEvent } from "@simulacra-ai/core";
import { collect_conversation_result } from "../aggregator.ts";

async function* events(...items: WireEvent[]): AsyncGenerator<WireEvent> {
  for (const e of items) {
    yield e;
  }
}

describe("collect_conversation_result", () => {
  it("returns concatenated text and tool calls from message_complete", async () => {
    const result = await collect_conversation_result(
      events({
        type: "message_complete",
        data: {
          request_id: "r1",
          usage: {},
          stop_reason: "tool_use",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "let me check " },
              { type: "text", text: "the weather" },
              {
                type: "tool",
                tool: "get_weather",
                tool_request_id: "tc_1",
                params: { city: "Tokyo" },
              },
            ],
          },
        },
      } as unknown as WireEvent),
    );
    expect(result.text).toBe("let me check the weather");
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].tool).toBe("get_weather");
  });

  it("throws when a request_error event arrives", async () => {
    await expect(
      collect_conversation_result(
        events({
          type: "request_error",
          data: {
            request_id: "r1",
            error: { name: "ProviderError", message: "rate limited" },
          },
        } as unknown as WireEvent),
      ),
    ).rejects.toThrow(/rate limited/);
  });

  it("returns empty text and no tool_calls when no message_complete is observed", async () => {
    const result = await collect_conversation_result(events());
    expect(result.text).toBe("");
    expect(result.tool_calls).toEqual([]);
  });
});
