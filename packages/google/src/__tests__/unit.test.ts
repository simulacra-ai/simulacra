import assert from "node:assert";
import type * as gemini from "@google/genai";
import { describe, expect, it, vi } from "vitest";

import type { ModelRequest, StreamReceiver } from "@simulacra-ai/core";
import { CancellationToken, CancellationTokenSource } from "@simulacra-ai/core";

import { GoogleProvider } from "../google-provider.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function make_response(
  candidates: gemini.Candidate[],
  usageMetadata?: Partial<gemini.GenerateContentResponseUsageMetadata>,
): gemini.GenerateContentResponse {
  return {
    candidates,
    usageMetadata: usageMetadata as gemini.GenerateContentResponseUsageMetadata,
  } as gemini.GenerateContentResponse;
}

function make_candidate(
  parts: gemini.Part[],
  finishReason?: gemini.FinishReason,
  index?: number,
): gemini.Candidate {
  return {
    content: {
      role: "model",
      parts,
    },
    finishReason,
    index: index ?? 0,
  };
}

async function* async_stream(
  ...responses: gemini.GenerateContentResponse[]
): AsyncGenerator<gemini.GenerateContentResponse> {
  for (const response of responses) {
    yield response;
  }
}

function make_mock_sdk(stream: AsyncGenerator<gemini.GenerateContentResponse>) {
  const generateContentStream = vi.fn().mockResolvedValue(stream);
  return {
    models: { generateContentStream },
  } as unknown as gemini.GoogleGenAI & {
    models: { generateContentStream: ReturnType<typeof vi.fn> };
  };
}

function make_receiver(): StreamReceiver & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const track =
    (name: string) =>
    (...args: unknown[]) => {
      calls[name] = calls[name] ?? [];
      calls[name].push(args);
    };
  return {
    calls,
    start_message: track("start_message"),
    update_message: track("update_message"),
    complete_message: track("complete_message"),
    start_content: track("start_content"),
    update_content: track("update_content"),
    complete_content: track("complete_content"),
    error: track("error"),
    before_request: track("before_request"),
    request_raw: track("request_raw"),
    response_raw: track("response_raw"),
    stream_raw: track("stream_raw"),
    cancel: track("cancel"),
  };
}

const no_cancel = CancellationToken.empty();

const base_request: ModelRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [],
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("GoogleProvider - construction", () => {
  it("stores config and exposes context_transformers", () => {
    const sdk = make_mock_sdk(async_stream());
    const provider = new GoogleProvider(sdk, { model: "gemini-2.0-flash-exp" }, []);
    expect(provider.context_transformers).toEqual([]);
  });

  it("clone returns new instance with same config", () => {
    const sdk = make_mock_sdk(async_stream());
    const provider = new GoogleProvider(sdk, { model: "gemini-2.0-flash-exp" }, []);
    const clone = provider.clone();
    expect(clone).not.toBe(provider);
    expect(clone).toBeInstanceOf(GoogleProvider);
    expect(clone.context_transformers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Streaming text response
// ---------------------------------------------------------------------------

describe("GoogleProvider - streaming text response", () => {
  it("calls receiver lifecycle methods for a text response", async () => {
    // First chunk: starts the candidate with initial text part
    const chunk1 = make_response([make_candidate([{ text: "Hello" }])]);
    // Second chunk: continues text in the same part
    const chunk2 = make_response([
      {
        content: { role: "model", parts: [{ text: " world" }] },
        index: 0,
        finishReason: "STOP" as gemini.FinishReason,
      },
    ]);

    const stream = async_stream(chunk1, chunk2);
    const sdk = make_mock_sdk(stream);
    const provider = new GoogleProvider(sdk, { model: "gemini-2.0-flash-exp" }, []);
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 50));

    // Lifecycle: before_request, request_raw, stream_raw, start_content, start_message,
    // then update_content, complete_content, complete_message, response_raw
    expect(receiver.calls.before_request).toHaveLength(1);
    expect(receiver.calls.request_raw).toHaveLength(1);
    expect(receiver.calls.stream_raw).toHaveLength(2);
    expect(receiver.calls.start_content).toBeDefined();
    expect(receiver.calls.start_message).toHaveLength(1);
    expect(receiver.calls.complete_content).toBeDefined();
    expect(receiver.calls.complete_message).toHaveLength(1);
    expect(receiver.calls.response_raw).toHaveLength(1);
  });

  it("handles multiple text parts in a single candidate", async () => {
    // First chunk starts candidate with one text part
    const chunk1 = make_response([make_candidate([{ text: "Part one" }])]);
    // Second chunk adds a new text part (different type transition triggers new part)
    // Since text+text merges, we need a thought part in between to force a new text part
    const chunk2 = make_response([
      {
        content: { role: "model", parts: [{ thought: true, text: "thinking..." }] },
        index: 0,
      },
    ]);
    // Third chunk: a new non-thought text part
    const chunk3 = make_response([
      {
        content: { role: "model", parts: [{ text: "Part two" }] },
        index: 0,
        finishReason: "STOP" as gemini.FinishReason,
      },
    ]);

    const stream = async_stream(chunk1, chunk2, chunk3);
    const sdk = make_mock_sdk(stream);
    const provider = new GoogleProvider(sdk, { model: "gemini-2.0-flash-exp" }, []);
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 50));

    // Should have multiple start_content calls (for each part started)
    expect(receiver.calls.start_content.length).toBeGreaterThanOrEqual(2);
    expect(receiver.calls.complete_message).toHaveLength(1);
  });

  it('maps finishReason "STOP" to stop_reason "end_turn"', async () => {
    const chunk1 = make_response([make_candidate([{ text: "Done" }])]);
    const chunk2 = make_response([
      {
        content: { role: "model", parts: [{ text: "." }] },
        index: 0,
        finishReason: "STOP" as gemini.FinishReason,
      },
    ]);

    const stream = async_stream(chunk1, chunk2);
    const sdk = make_mock_sdk(stream);
    const provider = new GoogleProvider(sdk, { model: "gemini-2.0-flash-exp" }, []);
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 50));

    const [complete_event] = receiver.calls.complete_message[0] as [{ stop_reason: string }];
    expect(complete_event.stop_reason).toBe("end_turn");
  });

  it("maps finishReason MAX_TOKENS to stop_reason max_tokens", async () => {
    const chunk1 = make_response([make_candidate([{ text: "Truncated" }])]);
    const chunk2 = make_response([
      {
        content: { role: "model", parts: [{ text: " output" }] },
        index: 0,
        finishReason: "MAX_TOKENS" as gemini.FinishReason,
      },
    ]);

    const stream = async_stream(chunk1, chunk2);
    const sdk = make_mock_sdk(stream);
    const provider = new GoogleProvider(sdk, { model: "gemini-2.0-flash-exp" }, []);
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 50));

    const [complete_event] = receiver.calls.complete_message[0] as [{ stop_reason: string }];
    expect(complete_event.stop_reason).toBe("max_tokens");
  });
});

// ---------------------------------------------------------------------------
// Tool call streaming
// ---------------------------------------------------------------------------

describe("GoogleProvider - tool call streaming", () => {
  it("emits functionCall part as tool content block with name and parsed args", async () => {
    const chunk1 = make_response([
      make_candidate([
        {
          functionCall: {
            id: "call_123",
            name: "get_weather",
            args: { city: "SF" },
          },
        },
      ]),
    ]);
    const chunk2 = make_response([
      {
        content: { role: "model", parts: [] },
        index: 0,
        finishReason: "STOP" as gemini.FinishReason,
      },
    ]);

    const stream = async_stream(chunk1, chunk2);
    const sdk = make_mock_sdk(stream);
    const provider = new GoogleProvider(sdk, { model: "gemini-2.0-flash-exp" }, []);
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 50));

    // start_content should have a tool content block
    expect(receiver.calls.start_content).toBeDefined();
    const [start_event] = receiver.calls.start_content[0] as [
      { content: { type: string; tool: string; tool_request_id: string; params: unknown } },
    ];
    expect(start_event.content.type).toBe("tool");
    expect(start_event.content.tool).toBe("get_weather");
    expect(start_event.content.tool_request_id).toBe("call_123");

    // complete_content should have the tool with args as an object
    const complete_events = receiver.calls.complete_content;
    const tool_complete = complete_events.find(
      (args: unknown[]) => (args[0] as { content: { type: string } }).content.type === "tool",
    );
    expect(tool_complete).toBeDefined();
    const [complete_event] = tool_complete as [
      { content: { type: string; params: Record<string, unknown> } },
    ];
    expect(complete_event.content.params).toEqual({ city: "SF" });

    // STOP with functionCall parts should map to stop_reason "tool_use"
    const [complete_msg] = receiver.calls.complete_message[0] as [{ stop_reason: string }];
    expect(complete_msg.stop_reason).toBe("tool_use");
  });

  it("handles function args as an object (not JSON string like OpenAI)", async () => {
    const args_object = { location: "New York", units: "celsius", details: true };
    const chunk1 = make_response([
      make_candidate([
        {
          functionCall: {
            id: "call_456",
            name: "get_forecast",
            args: args_object,
          },
        },
      ]),
    ]);
    const chunk2 = make_response([
      {
        content: { role: "model", parts: [] },
        index: 0,
        finishReason: "STOP" as gemini.FinishReason,
      },
    ]);

    const stream = async_stream(chunk1, chunk2);
    const sdk = make_mock_sdk(stream);
    const provider = new GoogleProvider(sdk, { model: "gemini-2.0-flash-exp" }, []);
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 50));

    // Verify the params are passed through as-is (object, not parsed from JSON string)
    const complete_events = receiver.calls.complete_content;
    const tool_complete = complete_events.find(
      (args: unknown[]) => (args[0] as { content: { type: string } }).content.type === "tool",
    );
    expect(tool_complete).toBeDefined();
    const [complete_event] = tool_complete as [
      { content: { type: string; params: Record<string, unknown> } },
    ];
    expect(complete_event.content.params).toEqual(args_object);
    // Verify it's an object, not a string
    expect(typeof complete_event.content.params).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("GoogleProvider - cancellation", () => {
  it("calls receiver.cancel when cancellation is requested", async () => {
    const chunk1 = make_response([make_candidate([{ text: "Hello" }])]);
    const chunk2 = make_response([
      {
        content: { role: "model", parts: [{ text: " world" }] },
        index: 0,
        finishReason: "STOP" as gemini.FinishReason,
      },
    ]);

    const stream = async_stream(chunk1, chunk2);
    const sdk = make_mock_sdk(stream);
    const provider = new GoogleProvider(sdk, { model: "gemini-2.0-flash-exp" }, []);
    const receiver = make_receiver();

    const cts = new CancellationTokenSource();
    cts.cancel();

    await provider.execute_request(base_request, receiver, cts.token);
    await new Promise((r) => setTimeout(r, 50));

    expect(receiver.calls.cancel).toHaveLength(1);
    expect(receiver.calls.complete_message).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("GoogleProvider - error handling", () => {
  it("propagates SDK error (generateContentStream throws)", async () => {
    const sdk = {
      models: {
        generateContentStream: vi.fn().mockRejectedValue(new Error("network failure")),
      },
    } as unknown as gemini.GoogleGenAI;

    const provider = new GoogleProvider(sdk, { model: "gemini-2.0-flash-exp" }, []);
    const receiver = make_receiver();

    await expect(provider.execute_request(base_request, receiver, no_cancel)).rejects.toThrow(
      "network failure",
    );
  });

  it("calls receiver.error when stream throws mid-iteration", async () => {
    const stream_error = new Error("stream exploded");
    async function* failing_stream(): AsyncGenerator<gemini.GenerateContentResponse> {
      yield make_response([make_candidate([{ text: "Hello" }])]);
      throw stream_error;
    }
    const sdk = make_mock_sdk(failing_stream());
    const provider = new GoogleProvider(sdk, { model: "gemini-2.0-flash-exp" }, []);
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 50));

    expect(receiver.calls.error).toHaveLength(1);
    expect(receiver.calls.error[0][0]).toBe(stream_error);
  });
});

// ---------------------------------------------------------------------------
// Bug: SAFETY/RECITATION finish reasons lose stop_details
// ---------------------------------------------------------------------------

describe("GoogleProvider - safety finish reasons preserve stop_details", () => {
  const safety_reasons: gemini.FinishReason[] = [
    "SAFETY" as gemini.FinishReason,
    "RECITATION" as gemini.FinishReason,
    "LANGUAGE" as gemini.FinishReason,
    "BLOCKLIST" as gemini.FinishReason,
    "PROHIBITED_CONTENT" as gemini.FinishReason,
    "SPII" as gemini.FinishReason,
    "IMAGE_SAFETY" as gemini.FinishReason,
  ];

  for (const reason of safety_reasons) {
    it(`maps finishReason "${reason}" to stop_reason "error" with stop_details`, async () => {
      const finish_message = `Content was blocked due to ${reason}`;
      const chunk1 = make_response([make_candidate([{ text: "Partial" }])]);
      const chunk2 = make_response([
        {
          content: { role: "model", parts: [{ text: " response" }] },
          index: 0,
          finishReason: reason,
          finishMessage: finish_message,
        },
      ]);

      const stream = async_stream(chunk1, chunk2);
      const sdk = make_mock_sdk(stream);
      const provider = new GoogleProvider(sdk, { model: "gemini-2.0-flash-exp" }, []);
      const receiver = make_receiver();

      await provider.execute_request(base_request, receiver, no_cancel);
      await new Promise((r) => setTimeout(r, 50));

      const [complete_event] = receiver.calls.complete_message[0] as [
        { stop_reason: string; stop_details?: string },
      ];
      expect(complete_event.stop_reason).toBe("error");
      expect(complete_event.stop_details).toBe(finish_message);
    });
  }
});

// ---------------------------------------------------------------------------
// Bug: Empty string text treated as falsy in from_gemini_part
// ---------------------------------------------------------------------------

describe("GoogleProvider - empty string text part", () => {
  it('classifies { text: "" } as "text" content, not "raw"', async () => {
    // First chunk has a non-empty text part to start the candidate
    const chunk1 = make_response([make_candidate([{ text: "Hello" }])]);
    // Second chunk has an empty string text part as a new part (preceded by a
    // thought part so the empty text part is not merged into the first one)
    const chunk2 = make_response([
      {
        content: { role: "model", parts: [{ thought: true, text: "hmm" }] },
        index: 0,
      },
    ]);
    const chunk3 = make_response([
      {
        content: { role: "model", parts: [{ text: "" }] },
        index: 0,
        finishReason: "STOP" as gemini.FinishReason,
      },
    ]);

    const stream = async_stream(chunk1, chunk2, chunk3);
    const sdk = make_mock_sdk(stream);
    const provider = new GoogleProvider(sdk, { model: "gemini-2.0-flash-exp" }, []);
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 50));

    // Find the start_content call that was triggered by the empty text part.
    // The empty text part should be classified as type "text", not type "raw".
    const start_events = receiver.calls.start_content as [
      { content: { type: string; text?: string; data?: string } },
    ][];
    const empty_text_event = start_events.find(
      ([event]) =>
        (event.content.type === "text" && event.content.text === "") ||
        (event.content.type === "raw" && event.content.data === '{"text":""}'),
    );
    assert(empty_text_event, "expected a start_content event for the empty text part");
    const [event] = empty_text_event;
    expect(event.content.type).toBe("text");
  });
});
