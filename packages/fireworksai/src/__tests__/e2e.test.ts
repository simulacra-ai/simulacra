/**
 * End-to-end tests for the FireworksAI provider.
 *
 * These tests make real HTTP requests to the Fireworks AI API.
 * They are skipped automatically when the FIREWORKS_API_KEY environment variable
 * is not set, so they are safe to run in CI without secrets configured.
 *
 * To run locally:
 *   FIREWORKS_API_KEY=your_key npm run test:e2e -w packages/fireworksai
 */
import type { CancellationToken, Message, ModelRequest, StreamReceiver } from "@simulacra-ai/core";
import { describe, expect, it } from "vitest";

import {
  FireworksAIProvider,
  createFireworksAIClient,
  type FireworksAIProviderConfig,
} from "../fireworksai-provider.ts";

const API_KEY = process.env.FIREWORKS_API_KEY;

// Default model – a fast, cheap model suitable for testing
const TEST_MODEL = "accounts/fireworks/models/llama-v3p1-8b-instruct";

// ---------------------------------------------------------------------------
// Helper: collect all events from a provider request
// ---------------------------------------------------------------------------

interface CollectedEvents {
  start_messages: unknown[];
  complete_messages: { message: Message; stop_reason: string; usage: unknown }[];
  content_starts: unknown[];
  content_completes: unknown[];
  errors: unknown[];
}

async function run_request(
  config: FireworksAIProviderConfig,
  request: ModelRequest,
): Promise<CollectedEvents> {
  const sdk = createFireworksAIClient(API_KEY as string);
  const provider = new FireworksAIProvider(sdk, config);
  const cancel: CancellationToken = { is_cancellation_requested: false };

  const collected: CollectedEvents = {
    start_messages: [],
    complete_messages: [],
    content_starts: [],
    content_completes: [],
    errors: [],
  };

  const receiver: StreamReceiver = {
    start_message: (e) => collected.start_messages.push(e),
    update_message: () => {},
    complete_message: (e) =>
      collected.complete_messages.push({
        message: e.message as Message,
        stop_reason: e.stop_reason,
        usage: e.usage,
      }),
    start_content: (e) => collected.content_starts.push(e),
    update_content: () => {},
    complete_content: (e) => collected.content_completes.push(e),
    error: (err) => collected.errors.push(err),
    before_request: () => {},
    request_raw: () => {},
    response_raw: () => {},
    stream_raw: () => {},
    cancel: () => {},
  };

  await provider.execute_request(request, receiver, cancel);
  // Wait for async streaming to fully finish
  await new Promise((r) => setTimeout(r, 5000));

  return collected;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!API_KEY)("FireworksAI E2E – simple conversation", () => {
  it("returns a text response for a basic prompt", async () => {
    const request: ModelRequest = {
      messages: [{ role: "user", content: [{ type: "text", text: "Say exactly: hello world" }] }],
      tools: [],
      system: "You are a helpful assistant. Follow instructions precisely.",
    };

    const events = await run_request({ model: TEST_MODEL, max_tokens: 64 }, request);

    expect(events.errors).toHaveLength(0);
    expect(events.complete_messages).toHaveLength(1);

    const { message, stop_reason } = events.complete_messages[0];
    expect(stop_reason).toBe("end_turn");
    expect(message.role).toBe("assistant");
    expect(message.content.length).toBeGreaterThan(0);

    const text_content = message.content.find((c) => c.type === "text");
    expect(text_content).toBeDefined();
    if (text_content && text_content.type === "text") {
      expect(text_content.text.toLowerCase()).toContain("hello");
    }
  }, 30_000);

  it("respects max_tokens and returns stop_reason max_tokens when truncated", async () => {
    const request: ModelRequest = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Count from 1 to 1000 with no abbreviations." }],
        },
      ],
      tools: [],
    };

    const events = await run_request({ model: TEST_MODEL, max_tokens: 10 }, request);

    expect(events.errors).toHaveLength(0);
    expect(events.complete_messages).toHaveLength(1);
    expect(events.complete_messages[0].stop_reason).toBe("max_tokens");
  }, 30_000);

  it("includes usage token counts in the response", async () => {
    const request: ModelRequest = {
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with: ok" }] }],
      tools: [],
    };

    const events = await run_request({ model: TEST_MODEL, max_tokens: 16 }, request);

    expect(events.errors).toHaveLength(0);
    const { usage } = events.complete_messages[0];
    expect((usage as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
    expect((usage as { output_tokens: number }).output_tokens).toBeGreaterThan(0);
  }, 30_000);
});

describe.skipIf(!API_KEY)("FireworksAI E2E – multi-turn conversation", () => {
  it("correctly sends conversation history in a follow-up turn", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "My favourite colour is blue." }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Got it! Blue is a great colour." }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "What is my favourite colour? Answer in exactly three words." },
        ],
      },
    ];

    const request: ModelRequest = { messages, tools: [] };
    const events = await run_request({ model: TEST_MODEL, max_tokens: 32 }, request);

    expect(events.errors).toHaveLength(0);
    const { message } = events.complete_messages[0];
    const text = (message.content.find((c) => c.type === "text") as { text: string } | undefined)
      ?.text;
    expect(text?.toLowerCase()).toContain("blue");
  }, 30_000);
});

describe.skipIf(!API_KEY)("FireworksAI E2E – tool use", () => {
  it("calls a tool when given a relevant prompt", async () => {
    const request: ModelRequest = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "What is the current weather in San Francisco?" }],
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get the current weather for a given city.",
          parameters: [
            {
              name: "city",
              type: "string",
              required: true,
              description: "The city to get weather for.",
            },
          ],
        },
      ],
    };

    const events = await run_request({ model: TEST_MODEL, max_tokens: 256 }, request);

    expect(events.errors).toHaveLength(0);
    expect(events.complete_messages).toHaveLength(1);

    const { message, stop_reason } = events.complete_messages[0];
    expect(stop_reason).toBe("tool_use");

    const tool_call = message.content.find((c) => c.type === "tool");
    expect(tool_call).toBeDefined();
    if (tool_call && tool_call.type === "tool") {
      expect(tool_call.tool).toBe("get_weather");
      expect((tool_call.params as { city: string }).city).toBeTruthy();
    }
  }, 30_000);

  it("completes a full tool-use round trip when results are provided", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "What is the weather in Paris?" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool",
            tool: "get_weather",
            tool_request_id: "call_weather_paris",
            params: { city: "Paris" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool: "get_weather",
            tool_request_id: "call_weather_paris",
            result: { result: true, temperature: "18°C", condition: "partly cloudy" },
          },
        ],
      },
    ];

    const request: ModelRequest = {
      messages,
      tools: [
        {
          name: "get_weather",
          description: "Get current weather",
          parameters: [{ name: "city", type: "string", required: true, description: "City name" }],
        },
      ],
    };

    const events = await run_request({ model: TEST_MODEL, max_tokens: 256 }, request);

    expect(events.errors).toHaveLength(0);
    const { message, stop_reason } = events.complete_messages[0];
    // After receiving tool results, model should give a text response
    expect(stop_reason).toBe("end_turn");
    const text = message.content.find((c) => c.type === "text");
    expect(text).toBeDefined();
  }, 30_000);
});

describe.skipIf(!API_KEY)("FireworksAI E2E – streaming events", () => {
  it("emits content_start and content_complete for each response block", async () => {
    const request: ModelRequest = {
      messages: [{ role: "user", content: [{ type: "text", text: "Say hi!" }] }],
      tools: [],
    };

    const events = await run_request({ model: TEST_MODEL, max_tokens: 32 }, request);

    expect(events.errors).toHaveLength(0);
    expect(events.content_starts.length).toBeGreaterThan(0);
    expect(events.content_completes.length).toBeGreaterThan(0);
    expect(events.content_completes.length).toBe(events.content_starts.length);
  }, 30_000);
});
