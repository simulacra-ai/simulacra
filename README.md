# Simulacra

Simulacra is a provider-agnostic JavaScript AI model toolkit, built around a stateful conversation engine. It supports streaming, tool calling, and api-call policy management. Additional extensions provide agentic orchestration workflows, MCP support, and session persistence.

## Quick Start

```bash
npm install @simulacra-ai/core @simulacra-ai/anthropic @anthropic-ai/sdk
```

```typescript
import { Conversation } from "@simulacra-ai/core";
import { AnthropicProvider } from "@simulacra-ai/anthropic";
import Anthropic from "@anthropic-ai/sdk";

const provider = new AnthropicProvider(new Anthropic(), { model: MODEL_NAME });
const conversation = new Conversation(provider);

await conversation.prompt("Hello!");
console.log(conversation.messages);
```

That's it — a provider, a conversation, a prompt. Everything else (streaming, tools, policies, orchestration) builds on top.

## Conversations

A conversation is a stateful dialogue with a model. It tracks message history, handles streaming, and emits events. The `Conversation` class is provider-agnostic. Providers are available for [Anthropic](packages/anthropic/README.md), [OpenAI](packages/openai/README.md), and [Google](packages/google/README.md).

Messages are stored in a normalized format independent of any provider's wire format, so a conversation started on one provider can be serialized and resumed on another.

## Streaming

Listen to events to handle responses as they stream in.

```typescript
conversation.on("content_update", (e) => {
  if (e.content?.type === "text" && e.content.text) process.stdout.write(e.content.text);
});
await conversation.prompt("Hello!");
```

The [developer guide](packages/core/DEVELOPER_GUIDE.md#events) provides a full breakdown of events.

## Tools

Tools are capabilities exposed to the model. Each tool declares a schema and an implementation. The model sees the schema, decides when to call it, and the framework handles execution. A `WorkflowManager` automates the tool call loop.

```typescript
import { WorkflowManager } from "@simulacra-ai/core";

class WeatherTool {
  static get_definition() {
    return {
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: [{ name: "city", type: "string", required: true }],
    };
  }
  constructor(context) {}
  async execute({ city }) {
    return { result: true, temperature: 72, conditions: "sunny" };
  }
}

conversation.toolkit = [WeatherTool];
const manager = new WorkflowManager(conversation);

await conversation.prompt("What's the weather in Tokyo?");
```

## Policies

Policies control request behavior — retries, rate limiting, token budgets. A default retry policy is included; pass `NoopPolicy` to disable.

```typescript
import { Conversation, RetryPolicy } from "@simulacra-ai/core";

const conversation = new Conversation(
  provider,
  new RetryPolicy({ max_attempts: 20, initial_backoff_ms: 250, backoff_factor: 1.5 }),
);
```

## Developer Guide

The [developer guide](packages/core/DEVELOPER_GUIDE.md) covers the full API: events, context transformers, policies, checkpoints, and extensibility.

## Packages

Package|Description
-|-
[`@simulacra-ai/core`](packages/core/README.md)|Conversations, tools, policies, context transformers
[`@simulacra-ai/anthropic`](packages/anthropic/README.md)|Anthropic Claude provider
[`@simulacra-ai/openai`](packages/openai/README.md)|OpenAI provider
[`@simulacra-ai/google`](packages/google/README.md)|Google Gemini provider
[`@simulacra-ai/mcp`](packages/mcp/README.md)|MCP client bridge
[`@simulacra-ai/session`](packages/session/README.md)|Session persistence and forking
[`@simulacra-ai/orchestration`](packages/orchestration/README.md)|Multi-agent execution patterns

## License

MIT
