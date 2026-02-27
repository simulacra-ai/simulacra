# Simulacra

[![Build](https://github.com/simulacra-ai/simulacra/actions/workflows/publish.yml/badge.svg)](https://github.com/simulacra-ai/simulacra/actions/workflows/publish.yml)
[![npm](https://img.shields.io/npm/v/@simulacra-ai/core)](https://www.npmjs.com/package/@simulacra-ai/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Simulacra is a TypeScript toolkit for building AI agents on top of stateful, multi-turn conversations. It is built around the `Conversation`, an ongoing dialogue with a model that holds message history, streams responses, executes tool calls, and drives the agentic loop. Messages are stored in a normalized format, so conversations can be serialized and resumed across different models. Adapter packages are available for [Anthropic](packages/anthropic), [OpenAI](packages/openai), and [Google](packages/google), and the extensibility model makes it straightforward to add others.

Tool use is supported out of the box, giving an AI model the ability to take actions or retrieve information. A workflow engine builds on top of the conversation to drive the agentic loop by executing tools and returning the results to the model until it produces a final response.

Several mechanisms are available to control behavior. Policies manage API call concerns like retries, rate limits, and token budgets. Context transformers can reshape messages before they reach the provider or after they come back. Checkpoints summarize long conversations to manage the context window.

Simulacra also supports complex agentic workflows with the [orchestration](#orchestration) package. It provides subagents, background workers, parallel fan-out, and agent pools. Orchestration can even be controlled directly by the model as tools to let it decide how and when to delegate work.

## Quick Start

```bash
npm install @simulacra-ai/core @simulacra-ai/anthropic @anthropic-ai/sdk
```

```typescript
import { Conversation } from "@simulacra-ai/core";
import { AnthropicProvider } from "@simulacra-ai/anthropic";
import Anthropic from "@anthropic-ai/sdk";

const provider = new AnthropicProvider(new Anthropic(), { model: MODEL_NAME });
using conversation = new Conversation(provider);

await conversation.prompt("Hello!");

console.log(conversation.messages);
```

## Streaming

Conversations emit events throughout their lifecycle. These can be used to stream content as it arrives, react to tool calls, or track state changes.

```typescript
// using the provider from Quick Start
using conversation = new Conversation(provider);

// stream text to the console as it arrives in real-time
conversation.on("content_update", ({ content }) => {
  if (content?.type === "text" && content.text) {
    process.stdout.write(content.text);
  }
});

await conversation.prompt("Hello!");
```

## Tools

Tools are custom actions that can be provided to the AI model to execute. `WorkflowManager` is used to drive the agentic loop, calling tools on the model's behalf and feeding results back until the model is done.

```typescript
import { WorkflowManager } from "@simulacra-ai/core";

// define a tool
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

// create a conversation and workflow manager
using conversation = new Conversation(provider);
using manager = new WorkflowManager(conversation);

// add the tool to the model's toolkit
conversation.toolkit = [WeatherTool];

// log responses as they complete
conversation.on("content_complete", ({ content }) => {
  if (content.type === "tool") {
    console.log(`Calling tool: ${content.tool}`);
  } else if (content.type === "text") {
    console.log(content.text);
  }
});

// ask it a question
await conversation.prompt("What's the weather in Tokyo?");
```

Tools can also be imported from MCP servers using the [MCP bridge](packages/mcp), which connects to any MCP-compatible tool server and exposes its tools to the model.

## Policies

Policies control how the underlying model provider is called, allowing retries, rate limiting, and token budgets. Policies can be combined using a `CompositePolicy` or used individually.

```typescript
import { Conversation, RetryPolicy } from "@simulacra-ai/core";

// create a retry policy with exponential backoff
const policy = new RetryPolicy({
  max_attempts: 20,
  initial_backoff_ms: 250,
  backoff_factor: 1.5,
});

// create a new conversation with the retry policy
using conversation = new Conversation(provider, policy);
```

## Orchestration

The [orchestration package](packages/orchestration) enables complex agentic workflows with several patterns included, like subagents, parallel fan-out, and background workers. Orchestration tools can be added to a conversation's toolkit, letting the model decide when and how to delegate.

```typescript
import { WorkflowManager } from "@simulacra-ai/core";
import { SubagentTask } from "@simulacra-ai/orchestration";

using conversation = new Conversation(provider);
using manager = new WorkflowManager(conversation);

// give the model access to the subagent tool
conversation.toolkit = [...conversation.toolkit, SubagentTask];

// the model can now delegate work to a subagent on its own
await conversation.prompt("Analyze this dataset and report your findings. Delegate the analysis to a subagent.");
```

## Sessions

The [session package](packages/session) manages and persists conversation data. A session is a conversation state that can be saved and resumed over time. Sessions are managed via the `SessionManager`, and the storage mechanism underlying it can be customized. Filesystem and in-memory stores are included out of the box.

```typescript
import { SessionManager, FileSessionStore } from "@simulacra-ai/session";

using conversation = new Conversation(provider);

const store = new FileSessionStore("./sessions");
using session = new SessionManager(store, conversation, { auto_save: true });

// resume a previous session by ID
await session.load(MY_SESSION_ID);
await conversation.prompt("Let's pick up where we left off.");
```

## Documentation

The [developer guide](packages/core/DEVELOPER_GUIDE.md) covers the full API, including events, context transformers, policies, and checkpoints. The [extensibility guide](packages/core/EXTENSIBILITY.md) covers custom context transformers, policies, and summarization strategies.

## Packages

Package|Description
-|-
[`@simulacra-ai/core`](packages/core)|Conversations, tools, policies, context transformers
[`@simulacra-ai/anthropic`](packages/anthropic)|Anthropic Claude provider
[`@simulacra-ai/openai`](packages/openai)|OpenAI provider
[`@simulacra-ai/google`](packages/google)|Google Gemini provider
[`@simulacra-ai/mcp`](packages/mcp)|MCP client bridge
[`@simulacra-ai/session`](packages/session)|Session persistence and forking
[`@simulacra-ai/orchestration`](packages/orchestration)|Multi-agent execution patterns

## License

MIT
