import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ModelRequest, StreamReceiver } from "@simulacra-ai/core";
import { CancellationToken, CancellationTokenSource } from "@simulacra-ai/core";

import { AnthropicProvider } from "../anthropic-provider.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* async_stream(
  ...events: Anthropic.Messages.RawMessageStreamEvent[]
): AsyncIterable<Anthropic.Messages.RawMessageStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function make_mock_sdk(
  stream: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>,
): Anthropic & { messages: { create: ReturnType<typeof vi.fn> } } {
  const create = vi.fn().mockResolvedValue(stream);
  return {
    messages: { create },
  } as unknown as Anthropic & { messages: { create: ReturnType<typeof vi.fn> } };
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

function make_message_start(
  usage: Partial<Anthropic.Messages.Usage> = {},
): Anthropic.Messages.RawMessageStartEvent {
  return {
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      container: null,
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        cache_creation: null,
        server_tool_use: null,
        service_tier: null,
        inference_geo: null,
        ...usage,
      },
    },
  };
}

function make_content_block_start_text(
  index: number,
  text = "",
): Anthropic.Messages.RawContentBlockStartEvent {
  return {
    type: "content_block_start",
    index,
    content_block: {
      type: "text",
      text,
      citations: null,
    },
  };
}

function make_content_block_start_tool(
  index: number,
  id: string,
  name: string,
): Anthropic.Messages.RawContentBlockStartEvent {
  return {
    type: "content_block_start",
    index,
    content_block: {
      type: "tool_use",
      id,
      name,
      input: {},
      caller: { type: "direct" },
    },
  };
}

function make_text_delta(
  index: number,
  text: string,
): Anthropic.Messages.RawContentBlockDeltaEvent {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  };
}

function make_input_json_delta(
  index: number,
  partial_json: string,
): Anthropic.Messages.RawContentBlockDeltaEvent {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json },
  };
}

function make_content_block_stop(index: number): Anthropic.Messages.RawContentBlockStopEvent {
  return {
    type: "content_block_stop",
    index,
  };
}

function make_message_delta(
  stop_reason: Anthropic.Messages.StopReason | null,
  output_tokens: number,
): Anthropic.Messages.RawMessageDeltaEvent {
  return {
    type: "message_delta",
    delta: {
      stop_reason,
      stop_sequence: null,
      container: null,
    },
    usage: {
      output_tokens,
      input_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
    },
  };
}

function make_message_stop(): Anthropic.Messages.RawMessageStopEvent {
  return { type: "message_stop" };
}

const base_request: ModelRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [],
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("AnthropicProvider - construction", () => {
  it("stores config and exposes empty context_transformers by default", () => {
    const sdk = make_mock_sdk(async_stream());
    const provider = new AnthropicProvider(sdk, { model: "claude-sonnet-4-20250514" });
    expect(provider.context_transformers).toEqual([]);
  });

  it("clone returns new instance with same config", () => {
    const sdk = make_mock_sdk(async_stream());
    const provider = new AnthropicProvider(sdk, {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
    });
    const clone = provider.clone();
    expect(clone).not.toBe(provider);
    expect(clone).toBeInstanceOf(AnthropicProvider);
    expect(clone.context_transformers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// System message handling
// ---------------------------------------------------------------------------

describe("AnthropicProvider - system message handling", () => {
  it("sends system prompt as top-level system param to SDK", async () => {
    const stream = async_stream(
      make_message_start(),
      make_content_block_start_text(0),
      make_text_delta(0, "Hi"),
      make_content_block_stop(0),
      make_message_delta("end_turn", 5),
      make_message_stop(),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new AnthropicProvider(sdk, {
      model: "claude-sonnet-4-20250514",
      prompt_caching: { system_prompt: false },
    });
    const receiver = make_receiver();

    await provider.execute_request(
      { ...base_request, system: "You are a helpful assistant." },
      receiver,
      no_cancel,
    );
    await new Promise((r) => setTimeout(r, 10));

    const [call_params] = sdk.messages.create.mock.calls[0];
    expect(call_params.system).toBe("You are a helpful assistant.");

    // System should NOT appear in messages array
    const messages = call_params.messages as { role: string }[];
    const system_in_messages = messages.find((m) => m.role === "system");
    expect(system_in_messages).toBeUndefined();
  });

  it("omits system param when undefined", async () => {
    const stream = async_stream(
      make_message_start(),
      make_content_block_start_text(0),
      make_text_delta(0, "Hi"),
      make_content_block_stop(0),
      make_message_delta("end_turn", 5),
      make_message_stop(),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new AnthropicProvider(sdk, { model: "claude-sonnet-4-20250514" });
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    const [call_params] = sdk.messages.create.mock.calls[0];
    expect(call_params.system).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Streaming text response
// ---------------------------------------------------------------------------

describe("AnthropicProvider - streaming text response", () => {
  it("calls receiver in correct order: start_message, start_content, update_content, complete_content, complete_message", async () => {
    const stream = async_stream(
      make_message_start(),
      make_content_block_start_text(0),
      make_text_delta(0, "Hello"),
      make_text_delta(0, " world"),
      make_content_block_stop(0),
      make_message_delta("end_turn", 5),
      make_message_stop(),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new AnthropicProvider(sdk, { model: "claude-sonnet-4-20250514" });
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    expect(receiver.calls.start_message).toHaveLength(1);
    expect(receiver.calls.start_content).toHaveLength(1);
    expect(receiver.calls.update_content?.length).toBeGreaterThanOrEqual(2);
    expect(receiver.calls.complete_content).toHaveLength(1);
    expect(receiver.calls.complete_message).toHaveLength(1);
    expect(receiver.calls.response_raw).toHaveLength(1);

    // Verify the start_content was for text type
    const [start_event] = receiver.calls.start_content[0] as [
      { content: { type: string; text: string } },
    ];
    expect(start_event.content.type).toBe("text");

    // Verify complete_content has the accumulated text
    const [complete_event] = receiver.calls.complete_content[0] as [
      { content: { type: string; text: string } },
    ];
    expect(complete_event.content.type).toBe("text");
    expect(complete_event.content.text).toBe("Hello world");
  });

  it("maps stop_reason end_turn correctly", async () => {
    const stream = async_stream(
      make_message_start(),
      make_content_block_start_text(0),
      make_text_delta(0, "Done"),
      make_content_block_stop(0),
      make_message_delta("end_turn", 3),
      make_message_stop(),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new AnthropicProvider(sdk, { model: "claude-sonnet-4-20250514" });
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    const [complete_event] = receiver.calls.complete_message[0] as [{ stop_reason: string }];
    expect(complete_event.stop_reason).toBe("end_turn");
  });

  it("maps stop_reason max_tokens correctly", async () => {
    const stream = async_stream(
      make_message_start(),
      make_content_block_start_text(0),
      make_text_delta(0, "Truncated"),
      make_content_block_stop(0),
      make_message_delta("max_tokens", 100),
      make_message_stop(),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new AnthropicProvider(sdk, { model: "claude-sonnet-4-20250514" });
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    const [complete_event] = receiver.calls.complete_message[0] as [{ stop_reason: string }];
    expect(complete_event.stop_reason).toBe("max_tokens");
  });
});

// ---------------------------------------------------------------------------
// Tool call streaming
// ---------------------------------------------------------------------------

describe("AnthropicProvider - tool call streaming", () => {
  it("emits tool content block with name, id, and parsed params from accumulated input_json_delta", async () => {
    const stream = async_stream(
      make_message_start(),
      make_content_block_start_tool(0, "toolu_123", "get_weather"),
      make_input_json_delta(0, '{"city":"SF"}'),
      make_content_block_stop(0),
      make_message_delta("tool_use", 10),
      make_message_stop(),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new AnthropicProvider(sdk, { model: "claude-sonnet-4-20250514" });
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    expect(receiver.calls.start_content).toBeDefined();
    const [start_event] = receiver.calls.start_content[0] as [
      { content: { type: string; tool: string; tool_request_id: string } },
    ];
    expect(start_event.content.type).toBe("tool");
    expect(start_event.content.tool).toBe("get_weather");
    expect(start_event.content.tool_request_id).toBe("toolu_123");

    // complete_content should have the parsed params
    const [complete_event] = receiver.calls.complete_content[0] as [
      { content: { type: string; params: Record<string, unknown> } },
    ];
    expect(complete_event.content.type).toBe("tool");
    expect(complete_event.content.params).toEqual({ city: "SF" });
  });

  it("correctly assembles tool arguments from multiple input_json_delta chunks", async () => {
    const stream = async_stream(
      make_message_start(),
      make_content_block_start_tool(0, "toolu_456", "calc"),
      make_input_json_delta(0, '{"a"'),
      make_input_json_delta(0, ":42,"),
      make_input_json_delta(0, '"b":'),
      make_input_json_delta(0, "99}"),
      make_content_block_stop(0),
      make_message_delta("tool_use", 15),
      make_message_stop(),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new AnthropicProvider(sdk, { model: "claude-sonnet-4-20250514" });
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    const [complete_event] = receiver.calls.complete_content[0] as [
      { content: { type: string; params: { a: number; b: number } } },
    ];
    expect(complete_event.content.type).toBe("tool");
    expect(complete_event.content.params).toEqual({ a: 42, b: 99 });
  });
});

// ---------------------------------------------------------------------------
// Usage tracking
// ---------------------------------------------------------------------------

describe("AnthropicProvider - usage tracking", () => {
  it("extracts input_tokens from message_start and output_tokens from message_delta", async () => {
    const stream = async_stream(
      make_message_start({ input_tokens: 42 }),
      make_content_block_start_text(0),
      make_text_delta(0, "Hi"),
      make_content_block_stop(0),
      make_message_delta("end_turn", 7),
      make_message_stop(),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new AnthropicProvider(sdk, { model: "claude-sonnet-4-20250514" });
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    // start_message should carry input_tokens from message_start
    const [start_event] = receiver.calls.start_message[0] as [{ usage: { input_tokens: number } }];
    expect(start_event.usage.input_tokens).toBe(42);

    // complete_message should carry merged usage with output_tokens from message_delta
    const [complete_event] = receiver.calls.complete_message[0] as [
      { usage: { input_tokens: number; output_tokens: number } },
    ];
    expect(complete_event.usage.input_tokens).toBe(42);
    expect(complete_event.usage.output_tokens).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Request options
// ---------------------------------------------------------------------------

describe("AnthropicProvider - request options", () => {
  it("passes static request_options to SDK create call", async () => {
    const stream = async_stream(
      make_message_start(),
      make_content_block_start_text(0),
      make_text_delta(0, "Hi"),
      make_content_block_stop(0),
      make_message_delta("end_turn", 5),
      make_message_stop(),
    );
    const sdk = make_mock_sdk(stream);
    const custom_headers = { "X-Custom": "test" };
    const provider = new AnthropicProvider(sdk, {
      model: "claude-sonnet-4-20250514",
      request_options: { headers: custom_headers },
    });
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    const call_args = sdk.messages.create.mock.calls[0];
    // Second argument is the request options
    expect(call_args[1]).toEqual({ headers: custom_headers });
  });

  it("resolves async request_options function before passing to SDK", async () => {
    const stream = async_stream(
      make_message_start(),
      make_content_block_start_text(0),
      make_text_delta(0, "Hi"),
      make_content_block_stop(0),
      make_message_delta("end_turn", 5),
      make_message_stop(),
    );
    const sdk = make_mock_sdk(stream);
    const custom_headers = { "X-Async": "resolved" };
    const provider = new AnthropicProvider(sdk, {
      model: "claude-sonnet-4-20250514",
      request_options: async () => ({ headers: custom_headers }),
    });
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    const call_args = sdk.messages.create.mock.calls[0];
    expect(call_args[1]).toEqual({ headers: custom_headers });
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("AnthropicProvider - error handling", () => {
  it("propagates SDK connection error (create throws)", async () => {
    const sdk = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("network failure")),
      },
    } as unknown as Anthropic;

    const provider = new AnthropicProvider(sdk, { model: "claude-sonnet-4-20250514" });
    const receiver = make_receiver();

    await expect(provider.execute_request(base_request, receiver, no_cancel)).rejects.toThrow(
      "network failure",
    );
  });

  it("completes without start_message or complete_message on empty stream", async () => {
    const stream = async_stream(); // empty - no events
    const sdk = make_mock_sdk(stream);
    const provider = new AnthropicProvider(sdk, { model: "claude-sonnet-4-20250514" });
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    // An empty stream should still call response_raw (with the partial message object)
    // but should NOT have called start_message or complete_message
    expect(receiver.calls.response_raw).toBeDefined();
    expect(receiver.calls.start_message).toBeUndefined();
    expect(receiver.calls.complete_message).toBeUndefined();
  });

  it("calls receiver.error when the stream throws", async () => {
    const stream_error = new Error("stream exploded");
    async function* failing_stream(): AsyncIterable<Anthropic.Messages.RawMessageStreamEvent> {
      yield make_message_start();
      throw stream_error;
    }
    const sdk = make_mock_sdk(failing_stream());
    const provider = new AnthropicProvider(sdk, { model: "claude-sonnet-4-20250514" });
    const receiver = make_receiver();

    await provider.execute_request(base_request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    expect(receiver.calls.error).toHaveLength(1);
    expect(receiver.calls.error[0][0]).toBe(stream_error);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("AnthropicProvider - cancellation", () => {
  it("calls receiver.cancel and skips complete_message when cancellation is requested", async () => {
    const stream = async_stream(
      make_message_start(),
      make_content_block_start_text(0),
      make_text_delta(0, "Hello"),
      make_content_block_stop(0),
      make_message_delta("end_turn", 5),
      make_message_stop(),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new AnthropicProvider(sdk, { model: "claude-sonnet-4-20250514" });
    const receiver = make_receiver();

    const cts = new CancellationTokenSource();
    cts.cancel();

    await provider.execute_request(base_request, receiver, cts.token);
    await new Promise((r) => setTimeout(r, 10));

    expect(receiver.calls.cancel).toHaveLength(1);
    expect(receiver.calls.complete_message).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Prompt caching defaults
// ---------------------------------------------------------------------------

describe("AnthropicProvider - prompt caching defaults", () => {
  it("wraps system prompt with cache_control when prompt_caching is omitted", async () => {
    const stream = async_stream(
      make_message_start(),
      make_content_block_start_text(0),
      make_text_delta(0, "Hi"),
      make_content_block_stop(0),
      make_message_delta("end_turn", 5),
      make_message_stop(),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new AnthropicProvider(sdk, { model: "claude-sonnet-4-20250514" });
    const receiver = make_receiver();

    await provider.execute_request({ ...base_request, system: "test system" }, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    const [call_params] = sdk.messages.create.mock.calls[0];
    expect(call_params.system).toEqual([
      { type: "text", text: "test system", cache_control: { type: "ephemeral" } },
    ]);
  });
});
