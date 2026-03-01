import type { OpenAI } from "openai";
import { describe, expect, it, vi } from "vitest";

import type { Message, ModelRequest, StreamReceiver } from "@simulacra-ai/core";
import { CancellationToken, CancellationTokenSource } from "@simulacra-ai/core";

import { OpenAIProvider } from "../openai-provider.ts";

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
    model: "gpt-4o",
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

const no_cancel = CancellationToken.empty();

// ---------------------------------------------------------------------------
// OpenAIProvider -- construction & clone
// ---------------------------------------------------------------------------

describe("OpenAIProvider -- construction", () => {
  it("stores the config and exposes an empty context_transformers array by default", () => {
    const sdk = make_mock_sdk(async_stream());
    const provider = new OpenAIProvider(sdk, { model: "gpt-4o" });
    expect(provider.context_transformers).toEqual([]);
  });

  it("clone() returns a new provider instance", () => {
    const sdk = make_mock_sdk(async_stream());
    const provider = new OpenAIProvider(sdk, { model: "gpt-4o", max_tokens: 100 });
    const clone = provider.clone();
    expect(clone).not.toBe(provider);
    expect(clone).toBeInstanceOf(OpenAIProvider);
  });
});

// ---------------------------------------------------------------------------
// execute_request -- system message handling
// ---------------------------------------------------------------------------

describe("OpenAIProvider -- system message handling", () => {
  it("uses 'system' role for GPT models", async () => {
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
    const provider = new OpenAIProvider(sdk, { model: "gpt-4o" });
    const receiver = make_receiver();

    const request: ModelRequest = {
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      tools: [],
      system: "You are a helpful assistant.",
    };

    await provider.execute_request(request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    const [call_params] = sdk.chat.completions.create.mock.calls[0];
    const system_msg = (call_params.messages as { role: string; content: string }[]).find(
      (m) => m.role === "system",
    );
    expect(system_msg).toBeDefined();
    expect(system_msg?.role).toBe("system");
    expect(system_msg?.content).toBe("You are a helpful assistant.");

    const dev_msg = (call_params.messages as { role: string }[]).find(
      (m) => m.role === "developer",
    );
    expect(dev_msg).toBeUndefined();
  });

  it("uses 'developer' role for o-series models", async () => {
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
    const provider = new OpenAIProvider(sdk, { model: "o3" });
    const receiver = make_receiver();

    const request: ModelRequest = {
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      tools: [],
      system: "You are a helpful assistant.",
    };

    await provider.execute_request(request, receiver, no_cancel);
    await new Promise((r) => setTimeout(r, 10));

    const [call_params] = sdk.chat.completions.create.mock.calls[0];
    const dev_msg = (call_params.messages as { role: string; content: string }[]).find(
      (m) => m.role === "developer",
    );
    expect(dev_msg).toBeDefined();
    expect(dev_msg?.role).toBe("developer");
    expect(dev_msg?.content).toBe("You are a helpful assistant.");

    const system_msg = (call_params.messages as { role: string }[]).find(
      (m) => m.role === "system",
    );
    expect(system_msg).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// execute_request -- streaming text response
// ---------------------------------------------------------------------------

describe("OpenAIProvider -- streaming text response", () => {
  it("calls all receiver lifecycle methods for a text response", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "Hell" }, null)] }),
      make_chunk({ choices: [make_choice(0, { content: "o!" }, null)] }),
      make_chunk({
        choices: [make_choice(0, {}, "stop")],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new OpenAIProvider(sdk, { model: "gpt-4o" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
      receiver,
      no_cancel,
    );
    await new Promise((r) => setTimeout(r, 10));

    // All expected callbacks must have been called
    expect(receiver.calls.start_content).toBeDefined();
    expect(receiver.calls.start_message).toBeDefined();
    expect(receiver.calls.update_content).toBeDefined();
    expect(receiver.calls.complete_content).toBeDefined();
    expect(receiver.calls.complete_message).toBeDefined();

    // Verify the text content was accumulated correctly
    const [complete_content_event] = receiver.calls.complete_content[0] as [
      { content: { type: string; text: string } },
    ];
    expect(complete_content_event.content.type).toBe("text");
    expect(complete_content_event.content.text).toBe("Hello!");
  });

  it("maps finish_reason 'stop' to stop_reason 'end_turn'", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "hi" }, null)] }),
      make_chunk({ choices: [make_choice(0, {}, "stop")] }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new OpenAIProvider(sdk, { model: "gpt-4o" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
      receiver,
      no_cancel,
    );
    await new Promise((r) => setTimeout(r, 10));

    const [complete_event] = receiver.calls.complete_message[0] as [{ stop_reason: string }];
    expect(complete_event.stop_reason).toBe("end_turn");
  });

  it("maps finish_reason 'length' to stop_reason 'max_tokens'", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "..." }, null)] }),
      make_chunk({ choices: [make_choice(0, {}, "length")] }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new OpenAIProvider(sdk, { model: "gpt-4o" });
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
});

// ---------------------------------------------------------------------------
// execute_request -- tool call streaming
// ---------------------------------------------------------------------------

describe("OpenAIProvider -- tool call streaming", () => {
  it("emits tool content block with name, id, and parsed params", async () => {
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
    const provider = new OpenAIProvider(sdk, { model: "gpt-4o" });
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

  it("accumulates streamed tool argument chunks across multiple deltas", async () => {
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
    const provider = new OpenAIProvider(sdk, { model: "gpt-4o" });
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

    // finish_reason "tool_calls" should map to stop_reason "tool_use"
    const [complete_msg] = receiver.calls.complete_message[0] as [{ stop_reason: string }];
    expect(complete_msg.stop_reason).toBe("tool_use");
  });
});

// ---------------------------------------------------------------------------
// User message conversion
// ---------------------------------------------------------------------------

describe("OpenAIProvider -- user message conversion", () => {
  it("converts a text user message correctly", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "hi" }, "stop")] }),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new OpenAIProvider(sdk, { model: "gpt-4o" });
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

  it("places tool_result content before regular text content in the message", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "done" }, "stop")] }),
    );
    const sdk = make_mock_sdk(stream);
    const provider = new OpenAIProvider(sdk, { model: "gpt-4o" });
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
// Usage tracking
// ---------------------------------------------------------------------------

describe("OpenAIProvider -- usage tracking", () => {
  it("extracts prompt_tokens and completion_tokens from stream usage chunk", async () => {
    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "hi" }, null)] }),
      make_chunk({
        choices: [make_choice(0, {}, "stop")],
        usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
      }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new OpenAIProvider(sdk, { model: "gpt-4o" });
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
// Cancellation
// ---------------------------------------------------------------------------

describe("OpenAIProvider -- cancellation", () => {
  it("calls receiver.cancel and skips complete_message when cancellation is requested", async () => {
    const source = new CancellationTokenSource();
    const cancel_token = source.token;
    source.cancel();

    const stream = async_stream(
      make_chunk({ choices: [make_choice(0, { role: "assistant", content: "hello" }, null)] }),
    );

    const sdk = make_mock_sdk(stream);
    const provider = new OpenAIProvider(sdk, { model: "gpt-4o" });
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
// Error handling
// ---------------------------------------------------------------------------

describe("OpenAIProvider -- error handling", () => {
  it("propagates SDK connection error when create throws", async () => {
    const sdk = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("network failure")),
        },
      },
    } as unknown as OpenAI;

    const provider = new OpenAIProvider(sdk, { model: "gpt-4o" });
    const receiver = make_receiver();

    await expect(
      provider.execute_request(
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
        receiver,
        no_cancel,
      ),
    ).rejects.toThrow("network failure");
  });

  it("calls receiver.error when stream throws mid-iteration", async () => {
    async function* failing_stream(): AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
      yield make_chunk({ choices: [make_choice(0, { role: "assistant", content: "hi" }, null)] });
      throw new Error("stream interrupted");
    }

    const sdk = make_mock_sdk(failing_stream());
    const provider = new OpenAIProvider(sdk, { model: "gpt-4o" });
    const receiver = make_receiver();

    await provider.execute_request(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
      receiver,
      no_cancel,
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(receiver.calls.error).toBeDefined();
    const [error_arg] = receiver.calls.error[0] as [Error];
    expect(error_arg.message).toBe("stream interrupted");
  });
});
