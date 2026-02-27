# Simulacra Core

The core package is the foundation of Simulacra. It provides a model-agnostic conversation engine that handles streaming, tool execution, retry policies, and context management.

## Installation

```bash
npm install @simulacra-ai/core
```

## Quick Start

```typescript
import { Conversation } from "@simulacra-ai/core";
import { AnthropicProvider } from "@simulacra-ai/anthropic";
import Anthropic from "@anthropic-ai/sdk";

const provider = new AnthropicProvider(new Anthropic(), { model: MODEL_NAME });
using conversation = new Conversation(provider);

await conversation.prompt("Hello!");

console.log(conversation.messages);
```

## Conversation

The `Conversation` class is the central object that the rest of the system is built on top of. It manages message history, sends prompts, and streams responses. A conversation is created with a `ModelProvider`, which handles all model-specific concerns like API calls, token limits, and thinking configuration. Providers are available for Anthropic, OpenAI, and Google, and the extensibility model makes it straightforward to add others.

The conversation itself is model-agnostic. All messages and state are represented in a normalized format, so conversations can be serialized, resumed, or switched to a different provider at any time.

```typescript
// create a conversation with a system prompt
using conversation = new Conversation(provider);
conversation.system = "You are a helpful assistant.";

await conversation.prompt("Hello!");

console.log(conversation.messages);
```

The [developer guide](DEVELOPER_GUIDE.md) includes the full API.

## Tools

Tools give an AI model the ability to take actions and retrieve information. Each tool is a class with a `get_definition` static method describing what it does and an `execute` method that runs when the model calls it. Tools are registered on the conversation via `toolkit`.

> Note: A `WorkflowManager` must be created to drive the tool call loop.

### Tool Definition

Each tool must provide a `ToolDefinition`, which declares its name, description, and parameters. The tool parameters can be primitives or complex types like arrays or objects with their own properties.

#### Parallel Behavior

The definition can include a `parallelizable` flag that tells the workflow engine how the tool should be executed. The flag defaults to `true`, allowing the engine to execute the tool in parallel when multiple tools are called in a batch. When explicitly disabled, the engine will execute the tool on its own before continuing to other tool calls.

> Note: Tool call batches are processed in order. Tools within the same batch run concurrently. If a non-parallelizable tool appears between parallelizable ones, the calls before and after it run as separate batches.

### Tool Context

The tool class constructor receives a `ToolContext` object that gives the tool access to the conversation, the active workflow, and any application-specific data passed via `context_data`.

```typescript
import type { ToolContext, ToolDefinition, ToolSuccessResult } from "@simulacra-ai/core";

class WeatherTool {
  constructor(context: ToolContext) {
    // context includes conversation, workflow, and context_data
  }

  async execute({ city }: { city: string }): Promise<ToolSuccessResult> {
    // called when the model invokes this tool
    return { result: true, temperature: 72, conditions: "sunny" };
  }

  static get_definition(): ToolDefinition {
    return {
      name: "get_weather",
      description: "Get current weather for a city",
      // parameter types: string, number, boolean, object, array
      parameters: [{ name: "city", type: "string", required: true }],
      // parallelizable defaults to true, set false for tools with side effects
    };
  }
}
```

## Workflows

The workflow engine drives the tool call loop and enables agentic behaviors. The `WorkflowManager` sits on top of the conversation object, managing workflow state and executing tools on the model's behalf, running them in parallel when possible, and feeding results back until the model produces a final response.

The workflow manager emits events throughout its lifecycle, making it possible to observe the full agentic loop.

```typescript
// create a conversation and workflow manager
using manager = new WorkflowManager(conversation);

// log the final message when the workflow completes
manager.once("workflow_begin", (workflow) =>
  workflow.once("workflow_end", () => {
    console.log(conversation.messages.at(-1));
  })
);

await conversation.prompt("Use my tools to answer this question.");
```

The [developer guide](DEVELOPER_GUIDE.md#events) covers the full event reference.

## Policies

Policies control how the underlying model provider is called. They sit between the conversation and the provider, intercepting requests to add behavior like retries, rate limiting, or token budgets. Policies can be used individually or combined with `CompositePolicy`.

### RetryPolicy

`RetryPolicy` retries failed requests with exponential backoff.

```typescript
// create a retry policy with an optional filter
const policy = new RetryPolicy({
  max_attempts: 3,
  initial_backoff_ms: 1000,
  backoff_factor: 2,
  retryable: (result) => result.error?.status === 429,
});
```

### CompositePolicy

`CompositePolicy` chains multiple policies together, executing them from outer to inner.

```typescript
// combine rate limiting with retries
const policy = new CompositePolicy(
  new RateLimitPolicy({ limit: 10, period_ms: 60_000 }),
  new RetryPolicy({ max_attempts: 3, initial_backoff_ms: 1000, backoff_factor: 2 }),
);
```

### RateLimitPolicy

`RateLimitPolicy` limits requests per time window.

```typescript
// create a rate limit policy
const policy = new RateLimitPolicy({ limit: 10, period_ms: 60_000 });

// create a conversation with the policy
using conversation = new Conversation(provider, policy);

// attach so the policy can observe conversation events
policy.attach(conversation);
```

### TokenLimitPolicy

`TokenLimitPolicy` limits tokens per time window.

```typescript
// create a token limit policy
const policy = new TokenLimitPolicy({
  period_ms: 60_000,
  total_tokens_per_period: 120_000,
});

// create a conversation with the policy
using conversation = new Conversation(provider, policy);

// attach so the policy can observe conversation events
policy.attach(conversation);
```

## Context Transformers

Context transformers reshape messages on-the-fly without altering the stored conversation history. They operate at two points, before messages are sent to the model (`transform_prompt`) and after a response comes back (`transform_completion`). This enables history trimming, content filtering, or constraint enforcement without touching the original messages.

By default, `Conversation` uses `ToolContextTransformer` and `CheckpointContextTransformer`. A custom transformer can be passed to override this.

### ToolContextTransformer (default)

Removes orphaned tool calls that lack corresponding tool results, preventing provider errors when tool execution was interrupted.

### CheckpointContextTransformer (default)

Replaces pre-checkpoint messages with the checkpoint summary, reducing context size while preserving conversation continuity. See [Checkpoints](DEVELOPER_GUIDE.md#checkpoints) in the developer guide.

### CompositeContextTransformer

Chains multiple transformers sequentially.

### NoopContextTransformer

Pass-through that disables all conversation-level transformations.

### Provider Context Transformers

Model providers can bundle their own transformers via `context_transformers`. These run before conversation-level transformers and handle provider-specific needs automatically.

The [developer guide](DEVELOPER_GUIDE.md#provider-context-transformers) covers the `ProviderContextTransformer` interface.

## Utilities

- `TokenTracker`. Attaches to a conversation to accumulate input/output token counts across requests.
- `CancellationTokenSource` / `CancellationToken`. Cooperative cancellation for async operations.
- `sleep(ms, cancellationToken?)`. Cancellable delay.
- `deep_merge(original, supplemental)`. Recursive object merge.

## License

MIT
