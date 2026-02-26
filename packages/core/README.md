# Simulacra Core

Core conversation engine, tool system, workflow management, policies, and context transformers for Simulacra.

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
const conversation = new Conversation(provider);

await conversation.prompt("Hello!");
console.log(conversation.messages);
```

## Conversation

`Conversation` is a concrete class that accepts a `ModelProvider` at construction time. Provider packages (`@simulacra-ai/anthropic`, `@simulacra-ai/openai`, `@simulacra-ai/google`) supply `ModelProvider` implementations. All model-specific configuration (model name, token limits, thinking, caching) lives in the provider, not the conversation.

```typescript
const conversation = new Conversation(provider);
conversation.system = "You are a helpful assistant.";

const result = await conversation.prompt("Hello!");
console.log(conversation.messages);
```

Properties include `id`, `state`, `system`, `toolkit`, and `messages`.

Methods include `prompt(text)`, `send_message(contents)`, `cancel_response()`, `clear()`, `load(messages)`, `spawn_child(fork?, id?, system?, is_checkpoint?)`, and `checkpoint(config?)`.

State transitions flow: `idle` → `awaiting_response` → `streaming_response` → `idle` (or `stopping` → `idle` on cancel, `disposed` on disposal).

### Conversation Events

Key events for streaming: `message_start`, `content_update`, `message_complete`. For tool use: `content_start`, `content_complete`. For lifecycle: `state_change`, `dispose`.

See the [developer guide](DEVELOPER_GUIDE.md#events) for the full event reference.

## Tool System

Tools are implemented via the `ToolClass` interface:

```typescript
import type {
  ToolClass,
  ToolContext,
  ToolDefinition,
  ToolSuccessResult,
  ToolErrorResult,
} from "@simulacra-ai/core";

class SearchTool {
  #context: ToolContext;

  static get_definition(): ToolDefinition {
    return {
      name: "search",
      description: "Search the web for information",
      parameters: [
        { name: "query", type: "string", required: true, description: "Search query" },
        { name: "max_results", type: "number", required: false, default: 5 },
      ],
      parallelizable: true,
    };
  }

  constructor(context: ToolContext) {
    this.#context = context;
  }

  async execute(params: {
    query: string;
    max_results?: number;
  }): Promise<ToolSuccessResult | ToolErrorResult> {
    const results = await doSearch(params.query, params.max_results ?? 5);
    return { result: true, ...results };
  }
}

conversation.toolkit = [SearchTool as ToolClass];
```

### ToolDefinition

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterDefinition[];
  parallelizable?: boolean; // default: true
}
```

### ToolContext

Every tool instance receives `{ conversation, workflow }` at construction time, plus any application-specific data passed via `context_data`.

### Parameter Types

`ToolParameterDefinition` supports: `string`, `number`, `boolean`, `object` (with nested `properties`), `array` (with `items`). String parameters support `enum` arrays. All types have `name`, `description?`, `required?`, and `default?`.

### Parallel Execution

The `parallelizable` flag (default `true`) controls batching in the workflow engine:

- **`true` (default)**: the workflow can batch this tool call with other parallelizable calls into `Promise.all`
- **`false`**: acts as a barrier; the workflow executes this tool alone, waiting for it to complete before continuing

This allows tools with side effects or ordering requirements to be marked as sequential while allowing read-only tools to run concurrently.

## Workflows

`WorkflowManager` is the agentic loop. It listens for tool-use responses, executes tools, sends results back, and repeats until the model produces a final response.

```typescript
import { WorkflowManager } from "@simulacra-ai/core";

const manager = new WorkflowManager(conversation);
await conversation.prompt("Use my tools to answer this question.");
```

For lower-level control, `Workflow` can be used directly — see the [developer guide](DEVELOPER_GUIDE.md#workflows).

Key events: `workflow_end` (loop finished with reason `complete` | `cancel` | `error`), `workflow_update` (tool results sent), `state_change`. See the [developer guide](DEVELOPER_GUIDE.md#events) for the full event reference.

## Policies

Policies wrap the LLM request with cross-cutting concerns. All policies implement `execute(cancellation_token, fn, ...args)`.

### RetryPolicy

`RetryPolicy` retries failed requests with exponential backoff.

```typescript
import { RetryPolicy } from "@simulacra-ai/core";

const policy = new RetryPolicy({
  max_attempts: 3,
  initial_backoff_ms: 1000,
  backoff_factor: 2,
  retryable: (error) => error.error?.status === 429, // optional filter
});
```

### RateLimitPolicy

`RateLimitPolicy` limits requests per time window. Pass it to the conversation constructor, then call `attach()` to subscribe to events.

```typescript
import { Conversation, RateLimitPolicy } from "@simulacra-ai/core";

const policy = new RateLimitPolicy({ limit: 10, period_ms: 60_000 });
const conversation = new Conversation(provider, policy);
policy.attach(conversation);
```

### TokenLimitPolicy

`TokenLimitPolicy` limits tokens per time window. Like `RateLimitPolicy`, it requires both constructor injection and `attach()`.

```typescript
import { Conversation, TokenLimitPolicy } from "@simulacra-ai/core";

const policy = new TokenLimitPolicy({
  period_ms: 60_000,
  total_tokens_per_period: 120_000,
});
const conversation = new Conversation(provider, policy);
policy.attach(conversation);
```

### CompositePolicy

`CompositePolicy` chains multiple policies together.

```typescript
import { CompositePolicy } from "@simulacra-ai/core";

const policy = new CompositePolicy(
  new RateLimitPolicy({ limit: 10, period_ms: 60_000 }),
  new RetryPolicy({ max_attempts: 3, initial_backoff_ms: 1000, backoff_factor: 2 }),
);
```

## Context Transformers

Context transformers modify messages at two points: before sending (`transform_prompt`) and after receiving (`transform_completion`).

By default, `Conversation` uses `ToolContextTransformer` and `CheckpointContextTransformer`. Pass a custom transformer to override.

### ToolContextTransformer (default)

Removes orphaned tool calls that lack corresponding tool results, preventing provider errors when tool execution was interrupted.

### CheckpointContextTransformer (default)

Replaces pre-checkpoint messages with the checkpoint summary, reducing context size while preserving conversation continuity. See [Checkpoints](DEVELOPER_GUIDE.md#checkpoints) in the developer guide.

### CompositeContextTransformer

Chains multiple transformers sequentially.

### NoopContextTransformer

Pass-through that disables all conversation-level transformations.

### Provider Context Transformers

Model providers can bundle their own transformers via `context_transformers`. These run before conversation-level transformers and handle provider-specific quirks automatically. The conversation reads them fresh on every request, supporting runtime provider swaps.

See the [developer guide](DEVELOPER_GUIDE.md#provider-context-transformers) for the `ProviderContextTransformer` interface.

## Utilities

- **`TokenTracker`**: attach to a conversation to accumulate input/output token counts across requests
- **`CancellationTokenSource` / `CancellationToken`**: cooperative cancellation for async operations
- **`sleep(ms, cancellationToken?)`**: cancellable delay
- **`deep_merge(original, supplemental)`**: recursive object merge

## License

MIT
