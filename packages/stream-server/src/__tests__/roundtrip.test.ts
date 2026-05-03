/**
 * End-to-end roundtrip: encoder → NDJSON adapter → client decoder.
 * Catches wire-format drift between server and client.
 */
import EventEmitter from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Conversation } from "@simulacra-ai/core";
import { collect_conversation_result, decode_ndjson } from "@simulacra-ai/stream-client";
import { encode_conversation } from "../encoder.ts";
import { to_ndjson_stream } from "../ndjson.ts";

function make_mock_conversation() {
  const emitter = new EventEmitter();
  const conv = {
    on: (n: string, l: (...args: unknown[]) => void) => emitter.on(n, l),
    off: (n: string, l: (...args: unknown[]) => void) => emitter.off(n, l),
    once: (n: string, l: (...args: unknown[]) => void) => emitter.once(n, l),
    cancel_response: vi.fn(),
  } as unknown as Conversation;
  return { conv, emitter };
}

describe("encoder ↔ decoder roundtrip via NDJSON", () => {
  it("a clean turn flows through end-to-end", async () => {
    const { conv, emitter } = make_mock_conversation();
    const { body } = to_ndjson_stream(encode_conversation(conv));

    emitter.emit("message_complete", {
      request_id: "r1",
      usage: {},
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello world" }],
      },
      stop_reason: "end_turn",
    });

    const result = await collect_conversation_result(decode_ndjson(body));
    expect(result.text).toBe("hello world");
    expect(result.tool_calls).toEqual([]);
  });

  it("a tool-call turn surfaces tool_calls", async () => {
    const { conv, emitter } = make_mock_conversation();
    const { body } = to_ndjson_stream(encode_conversation(conv));

    emitter.emit("message_complete", {
      request_id: "r2",
      usage: {},
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          {
            type: "tool",
            tool: "weather",
            tool_request_id: "trq_1",
            params: { city: "NYC" },
          },
        ],
      },
      stop_reason: "tool_use",
    });

    const result = await collect_conversation_result(decode_ndjson(body));
    expect(result.text).toBe("let me check");
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].tool).toBe("weather");
  });
});
