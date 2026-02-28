import type { OpenAI } from "openai";
import { describe, expect, it, vi } from "vitest";

import type {
  CancellationToken,
  Message,
  ModelRequest,
  StreamReceiver,
  ToolDefinition,
} from "@simulacra-ai/core";

import {
  FIREWORKS_BASE_URL,
  FireworksAIProvider,
  createFireworksAIClient,
} from "../fireworksai-provider.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function make_chunk(
  overrides: Partial<OpenAI.Chat.Completions.ChatCompletionChunk> & {
    choices?: OpenAI.Chat.Completions.ChatCompletionChunk.Choice[];
  } = {},
): OpenAI.Chat.Completions.ChatCompletionChunk {
  return {
    id: "cmpl-test",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "accounts/fireworks/models/llama-v3p1-8b-instruct",
    choices: [],
    ...overrides,
  };
}

function make_choice(
  index: number,
  delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta,
  finish_reason: OpenAI.Chat.Completions.ChatCompletionChunk.Choice["finish_reason"] = null,
): OpenAI.Chat.Completions.ChatCompletionChunk.Choice {
  return { index, delta, finish_reason, logprobs: null };
}

async function* async_stream(
  ...chunks: OpenAI.Chat.Completions.ChatCompletionChunk[]
): AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function make_mock_sdk(stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>): OpenAI {
  const create = vi.fn().mockResolvedValue(stream);
  return {
    chat: { completions: { create } },
  } as unknown as OpenAI;
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

const no_cancel: CancellationToken = { is_cancellation_requested: false };

// ---------------------------------------------------------------------------
// createFireworksAIClient
// ---------------------------------------------------------------------------

describe("createFireworksAIClient", () => {
  it("creates a client that is an object (basic smoke test)", () => {
    const client = createFireworksAIClient("test-key");
    expect(client).toBeDefined();
    expect(typeof client).toBe("object");
  });

  it("exports the correct base URL constant", () => {
    expect(FIREWORKS_BASE_URL).toBe("https://api.fireworks.ai/inference/v1");
  });
});

// ---------------------------------------------------------------------------
// FireworksAIProvider – construction & clone
// ---------------------------------------------------------------------------

describe("FireworksAIProvider – construction", () => {
  it("stores the config and exposes an empty context_transformers array by default", () => {
    const sdk = make_mock_sdk(async_stream());
    const provider = new FireworksAIProvider(sdk, { model: "my-model" });
    expect(provider.context_transformers).toEqual([]);
  });

  it("accepts custom context_transformers", () => {
    const sdk = make_mock_sdk(async_stream());
    const transformer = { transform_prompt: vi.fn() };
    const provider = new FireworksAIProvider(sdk, { model: "my-model" }, [transformer]);
    expect(provider.context_transformers).toHaveLength(1);
  });

  it("clone() returns a new provider with the same config", () => {
    const sdk = make_mock_sdk(async_stream());
    const provider = new FireworksAIProvider(sdk, { model: "my-model", max_tokens: 100 });
    const clone = provider.clone();
    expect(clone).not.toBe(provider);
    expect(clone).toBeInstanceOf(FireworksAIProvider);
  });
});

// ---------------------------------------------------------------------------
// execute_request – system message
// ---------------------------------------------------------------------------

describe("FireworksAIProvider – system message handling", () => {
  it("sends system prompt with role 'system' (not 'developer')", async () => {
    const stream = async_stream(
      make_chunk({
        choices: [make_choice(0, { role: "assistant", content: "hi" }, null)],
      }),
      make_chunk({
        choices: [make_choice(0, {}, "stop")],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "some-model" });
    const receiver = make_receiver();

    const request: ModelRequest = {
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      tools: [],
      system: "You are a helpful assistant.",
    };

    await provider.execute_request(request, receiver, no_cancel);
    // Give async streaming a tick to complete
    await new Promise((r) => setTimeout(r, 0));

    const [call_params] = sdk.chat.completions.create.mock.calls[0];
    const system_msg = (call_params.messages as { role: string; content: string }[]).find(
      (m) => m.role === "system",
    );
    expect(system_msg).toBeDefined();
    expect(system_msg?.role).toBe("system");
    expect(system_msg?.content).toBe("You are a helpful assistant.");

    // Must NOT have a 'developer' role message
    const dev_msg = (call_params.messages as { role: string }[]).find(
      (m) => m.role === "developer",
    );
    expect(dev_msg).toBeUndefined();
  });

  it("omits system message when system is undefined", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "ok" }, "stop")] }),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "some-model" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
      receiver,
      no_cancel,
    );

    const [call_params] = sdk.chat.completions.create.mock.calls[0];
    const system_msg = (call_params.messages as { role: string }[]).find(
      (m) => m.role === "system",
    );
    expect(system_msg).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// execute_request – streaming text
// ---------------------------------------------------------------------------

describe("FireworksAIProvider – streaming text response", () => {
  it("calls start_message, update_content, complete_message in order", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "Hell" }, null)] }),
      make_chunk({ choices: [make_choice(0, { content: "o!" }, null)] }),
      make_chunk({
        choices: [make_choice(0, {}, "stop")],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
      receiver,
      no_cancel,
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(receiver.calls.start_message).toBeDefined();
    expect(receiver.calls.complete_message).toBeDefined();
    expect(receiver.calls.stream_raw?.length).toBeGreaterThanOrEqual(1);
    expect(receiver.calls.response_raw).toBeDefined();
  });

  it("signals complete_message with stop_reason 'end_turn' on stop", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "hi" }, null)] }),
      make_chunk({ choices: [make_choice(0, {}, "stop")] }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
      receiver,
      no_cancel,
    );
    await new Promise((r) => setTimeout(r, 10));

    const [complete_event] = receiver.calls.complete_message[0] as [
      { stop_reason: string; message: { content: unknown[] } },
    ];
    expect(complete_event.stop_reason).toBe("end_turn");
  });

  it("signals stop_reason 'max_tokens' on length finish_reason", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "..." }, null)] }),
      make_chunk({ choices: [make_choice(0, {}, "length")] }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], tools: [] },
      receiver,
      no_cancel,
    );
    await new Promise((r) => setTimeout(r, 10));

    const [complete_event] = receiver.calls.complete_message[0] as [{ stop_reason: string }];
    expect(complete_event.stop_reason).toBe("max_tokens");
  });

  it("signals stop_reason 'tool_use' on tool_calls finish_reason", async () => {
    const stream = async_stream(
      make_chunk({
        choices: [
          make_choice(
            0,
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: { name: "my_tool", arguments: '{"x":1}' },
                },
              ],
            },
            null,
          ),
        ],
      }),
      make_chunk({ choices: [make_choice(0, {}, "tool_calls")] }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
      receiver,
      no_cancel,
    );
    await new Promise((r) => setTimeout(r, 10));

    const [complete_event] = receiver.calls.complete_message[0] as [{ stop_reason: string }];
    expect(complete_event.stop_reason).toBe("tool_use");
  });
});

// ---------------------------------------------------------------------------
// execute_request – tool call streaming
// ---------------------------------------------------------------------------

describe("FireworksAIProvider – tool call streaming", () => {
  it("emits start_content with a tool content block", async () => {
    const stream = async_stream(
      make_chunk({
        choices: [
          make_choice(
            0,
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_123",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"SF"}' },
                },
              ],
            },
            null,
          ),
        ],
      }),
      make_chunk({ choices: [make_choice(0, {}, "tool_calls")] }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "weather?" }] }], tools: [] },
      receiver,
      no_cancel,
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(receiver.calls.start_content).toBeDefined();
    const [start_event] = receiver.calls.start_content[0] as [
      { content: { type: string; tool: string; tool_request_id: string; params: unknown } },
    ];
    expect(start_event.content.type).toBe("tool");
    expect(start_event.content.tool).toBe("get_weather");
    expect(start_event.content.tool_request_id).toBe("call_123");
    expect(start_event.content.params).toEqual({ city: "SF" });
  });

  it("accumulates streamed tool argument chunks", async () => {
    const stream = async_stream(
      // First chunk: tool call start
      make_chunk({
        choices: [
          make_choice(
            0,
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_456",
                  type: "function",
                  function: { name: "calc", arguments: '{"a"' },
                },
              ],
            },
            null,
          ),
        ],
      }),
      // Second chunk: argument continuation
      make_chunk({
        choices: [
          make_choice(
            0,
            {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: ":42}" },
                },
              ],
            },
            null,
          ),
        ],
      }),
      make_chunk({ choices: [make_choice(0, {}, "tool_calls")] }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "calc" }] }], tools: [] },
      receiver,
      no_cancel,
    );
    await new Promise((r) => setTimeout(r, 10));

    // complete_content should have accumulated all argument chunks
    expect(receiver.calls.complete_content).toBeDefined();
    const [complete_event] = receiver.calls.complete_content[0] as [
      { content: { type: string; params: { a: number } } },
    ];
    expect(complete_event.content.type).toBe("tool");
    expect(complete_event.content.params).toEqual({ a: 42 });
  });
});

// ---------------------------------------------------------------------------
// execute_request – cancellation
// ---------------------------------------------------------------------------

describe("FireworksAIProvider – cancellation", () => {
  it("calls receiver.cancel() when cancellation is requested", async () => {
    const cancel_token: CancellationToken = { is_cancellation_requested: true };

    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "hello" }, null)] }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
      receiver,
      cancel_token,
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(receiver.calls.cancel).toBeDefined();
    expect(receiver.calls.complete_message).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// execute_request – error handling
// ---------------------------------------------------------------------------

describe("FireworksAIProvider – error handling", () => {
  it("rejects execute_request when the SDK throws during connection establishment", async () => {
    // The `create()` call is awaited inside execute_request, so connection-level
    // errors propagate as a rejected promise rather than through receiver.error().
    // (Errors that occur *during* streaming are routed to receiver.error().)
    const sdk = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("network failure")),
        },
      },
    } as unknown as OpenAI;

    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    await expect(
      provider.execute_request(
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
        receiver,
        no_cancel,
      ),
    ).rejects.toThrow("network failure");
  });

  it("calls receiver.error() when the stream yields no data", async () => {
    const stream = async_stream(); // empty stream
    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
      receiver,
      no_cancel,
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(receiver.calls.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// execute_request – tools passed to API
// ---------------------------------------------------------------------------

describe("FireworksAIProvider – tool definitions", () => {
  it("passes tool definitions to the API in OpenAI function format", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "ok" }, "stop")] }),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    const tool: ToolDefinition = {
      name: "add",
      description: "Add two numbers",
      parameters: [
        { name: "a", type: "number", required: true, description: "First number" },
        { name: "b", type: "number", required: true, description: "Second number" },
      ],
    };

    await provider.execute_request(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "1+2?" }] }],
        tools: [tool],
      },
      receiver,
      no_cancel,
    );

    const [call_params] = sdk.chat.completions.create.mock.calls[0];
    expect(call_params.tools).toBeDefined();
    expect(call_params.tools).toHaveLength(1);
    expect(call_params.tools[0].type).toBe("function");
    expect(call_params.tools[0].function.name).toBe("add");
    expect(call_params.tool_choice).toBe("auto");
  });

  it("omits tools and tool_choice when no tools provided", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "ok" }, "stop")] }),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
      receiver,
      no_cancel,
    );

    const [call_params] = sdk.chat.completions.create.mock.calls[0];
    expect(call_params.tools).toBeUndefined();
    expect(call_params.tool_choice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Message conversion – user messages
// ---------------------------------------------------------------------------

describe("FireworksAIProvider – user message conversion", () => {
  it("converts a text user message correctly", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "hi" }, "stop")] }),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "What is 2+2?" }] },
    ];

    await provider.execute_request({ messages, tools: [] }, receiver, no_cancel);

    const [call_params] = sdk.chat.completions.create.mock.calls[0];
    const user_msg = (call_params.messages as { role: string; content: string }[]).find(
      (m) => m.role === "user",
    );
    expect(user_msg?.content).toBe("What is 2+2?");
  });

  it("places tool_result content before regular user content (ordering requirement)", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "done" }, "stop")] }),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Here is the result:" },
          {
            type: "tool_result",
            tool: "calc",
            tool_request_id: "req_1",
            result: { result: true },
          },
        ],
      },
    ];

    await provider.execute_request({ messages, tools: [] }, receiver, no_cancel);

    const [call_params] = sdk.chat.completions.create.mock.calls[0];
    const sent_messages = call_params.messages as { role: string }[];
    // tool message should come before user text message
    const tool_idx = sent_messages.findIndex((m) => m.role === "tool");
    const user_idx = sent_messages.findLastIndex((m) => m.role === "user");
    expect(tool_idx).toBeGreaterThanOrEqual(0);
    expect(tool_idx).toBeLessThan(user_idx);
  });
});

// ---------------------------------------------------------------------------
// Message conversion – assistant messages with raw content
// ---------------------------------------------------------------------------

describe("FireworksAIProvider – assistant message raw content compatibility", () => {
  it("handles raw content with model_kind 'fireworksai'", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "ok" }, "stop")] }),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "raw", model_kind: "fireworksai", data: '{"custom_field":"value"}' }],
      },
    ];

    // Should not throw
    await expect(
      provider.execute_request({ messages, tools: [] }, receiver, no_cancel),
    ).resolves.toBeUndefined();
  });

  it("handles raw content with model_kind 'openai' (cross-provider compatibility)", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "ok" }, "stop")] }),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "raw", model_kind: "openai", data: '{"custom_field":"value"}' }],
      },
    ];

    await expect(
      provider.execute_request({ messages, tools: [] }, receiver, no_cancel),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Usage tracking
// ---------------------------------------------------------------------------

describe("FireworksAIProvider – usage tracking", () => {
  it("extracts input and output token counts from stream usage", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "hi" }, null)] }),
      make_chunk({
        choices: [make_choice(0, {}, "stop")],
        usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
      }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
      receiver,
      no_cancel,
    );
    await new Promise((r) => setTimeout(r, 10));

    const [complete_event] = receiver.calls.complete_message[0] as [
      { usage: { input_tokens: number; output_tokens: number } },
    ];
    expect(complete_event.usage.input_tokens).toBe(42);
    expect(complete_event.usage.output_tokens).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Before request / raw request hooks
// ---------------------------------------------------------------------------

describe("FireworksAIProvider – request hooks", () => {
  it("calls before_request and request_raw before streaming starts", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "hi" }, "stop")] }),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new FireworksAIProvider(sdk, { model: "test", max_tokens: 256 });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
      receiver,
      no_cancel,
    );

    expect(receiver.calls.before_request).toHaveLength(1);
    expect(receiver.calls.request_raw).toHaveLength(1);

    const [raw] = receiver.calls.request_raw[0] as [{ model: string; max_tokens: number }];
    expect(raw.model).toBe("test");
    expect(raw.max_tokens).toBe(256);
  });
});
