# Developer Guide

This guide covers core concepts (conversations, tools, workflows, policies, context transformers) and the event system. For extending the library with new model providers, context transformers, and policies, see the [extensibility guide](EXTENSIBILITY.md).

## Conversation

The `Conversation` class manages the conversation state, message history, prompt, and tools.

### Properties

- `id`: Unique identifier for this conversation.
- `state`: Current conversation state. Valid values: `idle`, `awaiting_response`, `streaming_response`, `stopping`, `disposed`.
- `system`: System prompt sent with every request.
- `toolkit`: Array of tool classes the model can call.
- `messages`: Full message history containing all user and assistant messages.

### Methods

- `prompt(text)`: Sends a user message containing a single text block and requests a response.
- `send_message(contents)`: Sends a user message with one or more content blocks (text, tool results, multi-modal, etc).
- `cancel_response()`: Cancels the in-flight request.
- `clear()`: Deletes all messages from the conversation history.
- `load(messages)`: Replaces the entire message history. Used for deserialization or forking conversations.
- `spawn_child(fork_session?, id?, system_prompt?, is_checkpoint?)`: Creates a child conversation. Optionally fork the message history, set a custom ID, override the system prompt, or mark as a checkpoint session.
- `checkpoint(config?)`: Creates a checkpoint summary of the conversation. See [Checkpoints](#checkpoints).
- `on(event, listener)` / `once(event, listener)` / `off(event, listener)`: Subscribe or unsubscribe to [conversation events](#conversation-events).

### Child Conversations

A conversation can spawn children via `spawn_child`. A child inherits the parent's provider, toolkit, and policies. The child can optionally fork the parent's message history, starting with a copy of all existing messages. When a child is created without forking the parent's conversation, it starts as a fresh conversation with no message history.

Child conversations are the building block behind several higher-level features. The orchestration package uses them to give each subagent its own conversation. Checkpoints spawn an ephemeral child to generate a summary.

## Tools

A tool is a capability the model can invoke to perform actions or retrieve information. Each tool has a schema (defining its name, parameters, and description) and an implementation (the code that runs when called). Tools are implemented as classes and registered via `conversation.toolkit`.

### Implementing a Tool

Tools implement the `ToolClass` interface with a static `get_definition()` method and an instance `execute()` method.

```typescript
import type { ToolClass, ToolContext, ToolDefinition, ToolSuccessResult } from "@simulacra-ai/core";

class GetTimeTool {
  constructor(context: ToolContext) {}

  async execute({ timezone = "UTC" }): Promise<ToolSuccessResult> {
    const time = new Date().toLocaleString("en-CA", { timeZone: timezone });
    return { result: true, time };
  }

  static get_definition(): ToolDefinition {
    return {
      name: "get_time",
      description: "Get the current time",
      parameters: [{ name: "timezone", type: "string", required: false }],
    };
  }
}

conversation.toolkit = [GetTimeTool];
```

### ToolContext

Every tool's constructor receives a context object containing `conversation` and `workflow` references.

**context_data** provides application-specific data to all tools in a workflow, such as database connections, loggers, or configuration. `context_data` is passed when creating the workflow manager, and its properties are spread directly into the tool context object so that tools can access them as top-level fields on the context parameter.

```typescript
const workflowManager = new WorkflowManager(conversation, {
  context_data: { db_connection, logger },
});

// In the tool constructor:
constructor(context: ToolContext) {
  this.#db = context.db_connection as DatabaseConnection;
  this.#logger = context.logger as Logger;
}
```

### Parameter types

`ToolParameterDefinition` supports primitives, objects, and arrays:

```typescript
parameters: [
  { name: "name", type: "string", required: true },
  { name: "count", type: "number", default: 10 },
  { name: "verbose", type: "boolean", required: false },
  { name: "format", type: "string", enum: ["json", "csv", "table"] },
  {
    name: "filters",
    type: "object",
    properties: {
      status: { type: "string", enum: ["active", "archived"] },
      min_date: { type: "string" },
    },
  },
  {
    name: "tags",
    type: "array",
    items: { type: "string" },
  },
];
```

### Parallelization

By default, tool calls execute in parallel when the model requests multiple tools. Tools can disable this by setting `parallelizable: false` in their definition.

#### Parallel (default)

The tool runs concurrently with other parallelizable tools in the same batch.

#### Non-parallel

The tool acts as a barrier, executing alone and blocking other tool calls until it completes. Appropriate for tools with side effects or ordering dependencies.

## Workflows

Workflows handle two primary concerns: executing tool calls requested by the model, and queuing messages to be processed after the current sequence completes.

Workflows are the foundation for building agentic systems. The [@simulacra-ai/orchestration](../orchestration/README.md) package builds on workflows to add multi-agent patterns like subagents, parallel fan-out, and background workers.

### WorkflowManager

`WorkflowManager` automatically creates and manages `Workflow` instances. It listens for `prompt_send` events on the conversation and spins up a workflow to handle tool execution until the model produces a final response.

```typescript
import { WorkflowManager } from "@simulacra-ai/core";

const manager = new WorkflowManager(conversation);

await conversation.prompt("What time is it in Tokyo?");
// Tool calls execute, results are sent back, and the process repeats until the model finishes
```

#### Properties

- `state`: Current state. Valid values: `idle`, `busy`, `disposed`.
- `conversation`: The managed conversation.
- `current_workflow`: The active `Workflow` instance, or `undefined` when idle.

#### Functions

- `on(event, listener)` / `once(event, listener)` / `off(event, listener)`: Subscribe or unsubscribe to [workflow manager events](#workflowmanager-events).

State transitions flow: `idle` > `busy` > `idle` (on workflow completion) or `disposed` (on disposal).

The manager also transitions to `busy` during checkpoint generation and back to `idle` when the checkpoint completes.

### Workflow

`Workflow` is the lower-level primitive. Most users should use `WorkflowManager`, but `Workflow` is useful when you need direct control over the agentic loop, such as in orchestration patterns.

#### Properties

- `id`: Unique identifier for this workflow.
- `state`: Current state. Valid values: `idle`, `busy`, `disposed`.
- `conversation`: The managed conversation.
- `parent`: Parent workflow, if this is a child.
- `messages`: Message history tracked by this workflow.
- `queued_messages`: Messages queued for sending after the current response completes.

#### Functions

- `start(message?)`: Starts the workflow. Optionally begins with an initial user message.
- `cancel()`: Cancels the workflow, stopping any in-progress response.
- `spawn_child(conversation, id?, context_data?)`: Creates a child workflow. Optionally merges additional context data into the child. Child events bubble up as `child_workflow_event`.
- `queue_message(text)`: Queues a message to send after the current response completes.
- `clear_queue()`: Clears all queued messages.
- `on(event, listener)` / `once(event, listener)` / `off(event, listener)`: Subscribe or unsubscribe to [workflow events](#workflow-events).

### Message Queuing

Message queuing holds messages while the workflow processes. Upon completion, the next queued message is automatically dequeued and sent. Message queuing is tracked through `message_queued`, `message_dequeued`, and `queue_cleared` events.

```typescript
const manager = new WorkflowManager(conversation);

if (manager.state === "busy") {
  manager.current_workflow?.queue_message("Follow up question");
} else {
  conversation.prompt("Follow up question");
}
```

## Content

Messages are composed of content blocks. Each block has a type and type-specific fields.

### Message Structure

Each message has a `role` (`user` or `assistant`) and an array of `content` blocks. User messages only contain user content types; assistant messages only contain assistant content types.

A message can contain multiple blocks, enabling multi-modal or mixed content in a single turn.

### User Content

- **TextContent**: Plain text input. 

  `{ type: "text", text: "Hello, how are you?" }`

- **ToolResultContent**: Represents the result of a tool execution. Not normally created directly by users. 

  `{ type: "tool_result", tool: "get_time", tool_request_id: "req_123", result: { time: "2:30 PM" } }`

- **RawContent**: Provider-specific content for multimodal input or custom provider features. 

  `{ type: "raw", model_kind: "anthropic", data: "..." }`

### Assistant Content

- **TextContent**: The model's text response.

  `{ type: "text", text: "I'm doing well, thanks for asking!" }`

- **ThinkingMessageContent**: Extended reasoning output when the provider supports it.

  `{ type: "thinking", thought: "The user is asking about..." }`

- **ToolContent**: A request from the model to execute a tool.

  `{ type: "tool", tool_request_id: "req_123", tool: "get_time", params: { timezone: "UTC" } }`

- **RawContent**: Provider-specific content for multimodal output or custom provider features.

  `{ type: "raw", model_kind: "anthropic", data: "..." }`

## Policies

Policies modify model API request behavior, adding capabilities like retries, rate limiting, or logging. They operate at the provider-agnostic abstraction layer, wrapping request execution to intercept, modify, or repeat calls uniformly across all providers. By default, conversations use a retry policy with exponential backoff.

```typescript
const policy = new CompositePolicy(
  new RateLimitPolicy({ limit: 10, period_ms: 60000 }),
  new RetryPolicy({ max_attempts: 3, initial_backoff_ms: 1000, backoff_factor: 2 }),
);

const conversation = new Conversation(provider, policy);
```

### Policy Composition

Multiple policies can be chained using `CompositePolicy`. Policies execute in order from outer to inner.

[Custom policies](EXTENSIBILITY.md#policies) can be built by extending the policy base class.

### Event-Observing Policies

Some policies track conversation state by observing events. These policies expose an `attach(conversation)` method that must be called after conversation construction to subscribe to events.

```typescript
const tokenLimit = new TokenLimitPolicy({
  period_ms: 60000,
  total_tokens_per_period: 100000,
});

const conversation = new Conversation(provider, tokenLimit);
tokenLimit.attach(conversation);

await conversation.prompt("Hello!");
```

`RateLimitPolicy` and `TokenLimitPolicy` both require manual attachment. The policy is passed to the conversation constructor to control request execution, then `attach()` is called to subscribe to events like `message_complete` or `request_success` for tracking usage.

### Built-in Policies

The following policies are included in the core package.

Policy|Description|Options|Notes
-|-|-|-
`RetryPolicy`|Retries the request on failure with exponential backoff|`max_attempts`, `initial_backoff_ms`, `backoff_factor`, optional `retryable(result)`|Default if no policy specified
`RateLimitPolicy`|Limits requests per time window|`limit`, `period_ms`|Requires `attach(conversation)` so it can observe `request_success` and child events
`TokenLimitPolicy`|Limits input/output or total tokens per period|`period_ms` + either `input_tokens_per_period`/`output_tokens_per_period` or `total_tokens_per_period`|Requires `attach(conversation)` to track usage from `message_complete` and child events
`CompositePolicy`|Stacks multiple policies|`...policies`|Executes outer to inner
`NoopPolicy`|Pass-through, no behavior|(none)|Disables the default retry when passed

## Token Management

### TokenTracker

`TokenTracker` tracks token consumption across a conversation and its children.

```typescript
import { TokenTracker } from "@simulacra-ai/core";

using tracker = new TokenTracker(conversation);

tracker.on("stats_update", (stats) => {
  console.log(`Last: ${stats.last_request.input} in / ${stats.last_request.output} out`);
  console.log(`Total: ${stats.total.input} in / ${stats.total.output} out`);
});
```

`TokenLimitPolicy` enforces a token budget over a sliding time window, complementing `TokenTracker`'s passive tracking with active rate limiting. See [Policies](#policies) for configuration and usage.

## Context Transformers

Context transformers modify messages on-the-fly without altering the stored conversation. They transform messages as they're sent to the model or received back, enabling history trimming, content filtering, or constraint enforcement.

By default, `Conversation` uses a composite transformer with `ToolContextTransformer` and `CheckpointContextTransformer`. You only need to provide a custom transformer if you want to change this behavior.

```typescript
// Uses default transformers (ToolContextTransformer + CheckpointContextTransformer)
const conversation = new Conversation(provider, policy);

// Custom transformer overrides the default
const conversation = new Conversation(provider, policy, new NoopContextTransformer());
```

[Custom context transformers](EXTENSIBILITY.md#context-transformers) can be built by implementing the `ContextTransformer` interface.

### Built-in Transformers

The following transformers are included in the core package.

Transformer|Description|Notes
-|-|-
`ToolContextTransformer`|Removes orphaned tool calls without results|Default
`CheckpointContextTransformer`|Replaces pre-checkpoint messages with summary|Default
`CompositeContextTransformer`|Chains multiple transformers|
`NoopContextTransformer`|Pass-through|Use to disable defaults

### Provider Context Transformers

Model providers can include their own context transformers via the `context_transformers` property. These run before conversation-level transformers and normalize provider-specific quirks (e.g., Google's `tool_code` block parsing). The conversation reads them fresh on every request, so model routing providers can swap them at runtime.

```typescript
import { ProviderContextTransformer } from "@simulacra-ai/core";

class MyProviderTransformer implements ProviderContextTransformer {
  transform_completion(message: AssistantMessage) {
    // normalize provider-specific output
    return Promise.resolve(message);
  }
}
```

Provider transformers use the `ProviderContextTransformer` interface, which differs from `ContextTransformer`: no `TransformContext` parameter, and both methods are optional.

## Checkpoints

Checkpoints summarize the conversation so far into a compact state, allowing long-running conversations to stay within context limits. When a checkpoint is created, an ephemeral child conversation generates a summary. On subsequent prompts, the `CheckpointContextTransformer` replaces all pre-checkpoint messages with that summary.

### Setup

Checkpointing requires a `CheckpointContextTransformer` in the transformer pipeline (included by default). A `WorkflowManager` wrapping the conversation is recommended so the system reports "busy" during checkpoint generation, but it is not strictly required.

```typescript
import { Conversation, WorkflowManager } from "@simulacra-ai/core";

const conversation = new Conversation(provider, policy);
const manager = new WorkflowManager(conversation);
```

### Creating a Checkpoint

Call `checkpoint()` on an idle conversation with at least one message:

```typescript
const state = await conversation.checkpoint();
// state = { message_id: "...", summary: "..." }
```

The checkpoint process spawns a child conversation, sends the conversation history to the model via the `SummarizationStrategy`, and stores the resulting summary.

### Default Summarization Strategy

`DefaultSummarizationStrategy` serializes the conversation (including system prompt and any previous checkpoint summary) into a structured prompt asking the model to produce a concise briefing. Custom strategies can be provided via the conversation constructor. The [extensibility guide](EXTENSIBILITY.md#summarization-strategies) covers the interface and includes a full example.

## Events

Conversation, Workflow, and WorkflowManager emit events throughout their lifecycle. Events notify listeners of state changes, streaming data, tool execution, and other actions taken during a conversation or workflow.

```typescript
// Stream text as it arrives
conversation.on("content_update", (event) => {
  if (event.content.type === "text" && event.content.text) {
    process.stdout.write(event.content.text);
  }
});

// One-time listener for first response
conversation.once("message_start", () => {
  console.log("Response started...");
});
```

For token usage tracking, see [Token Management](#token-management) above.

### Child Event Bubbling

Child conversations and workflows bubble their events up to their parents. When a child emits an event, the parent receives a corresponding event (`child_event` for conversations, `child_workflow_event` for workflows) containing the event name and arguments from the child.

Event bubbling propagates through the entire tree. A parent observes events from its immediate children and all descendants. This makes it possible to track token usage across a conversation tree, aggregate logs from multiple workflows, or forward all events to external systems from a single listener.

```typescript
// Listen to child conversation events
conversation.on("child_event", ({ event_name, event_args }) => {
  if (event_name === "message_complete") {
    const [event] = event_args;
    console.log(`Child used ${event.usage.input_tokens} input, ${event.usage.output_tokens} output tokens`);
  }
});

// Listen to child workflow events
workflow.on("child_workflow_event", ({ event_name, event_args }) => {
  if (event_name === "workflow_end") {
    const [event] = event_args;
    console.log(`Child workflow ended: ${event.reason}`);
  }
});
```

### Conversation Events

Event|Payload Type|Notes
-|-|-
`state_change`|`{ current, previous }`|
`prompt_send`|`{ message }`|Emitted before sending a user message
`message_start`|`{ request_id, usage, message }`|Emitted when the provider starts a new message
`message_update`|`{ request_id, usage, message }`|Emitted during message streaming
`message_complete`|`{ request_id, usage, message, stop_reason, stop_details? }`|
`content_start`|`{ request_id, usage, message, content }`|Emitted when the provider starts a content block
`content_update`|`{ request_id, usage, message, content }`|Emitted during content streaming
`content_complete`|`{ request_id, usage, message, content }`|
`request_success`|prompt request data, policy metadata|Emitted after policy execution completes
`request_error`|`{ message, error }`, metadata|Emitted after policy execution fails
`before_request`|`{ data }`|
`raw_request`|`{ request_id, data }`|
`raw_response`|`{ request_id, data }`|
`raw_stream`|`{ request_id, data }`|
`checkpoint_begin`|`Conversation`|The payload is the checkpoint child conversation
`checkpoint_complete`|`CheckpointState`|The payload is the new checkpoint state
`create_child`|`Conversation`|The payload is the child conversation
`child_event`|`{ event_name, event_args }`|Bubbles child events up to the parent conversation
`lifecycle_error`|`{ error, operation, context? }`|Infrastructure or lifecycle failure (e.g., session save, fork)
`dispose`||

### Workflow Events

Event|Payload Type|Notes
-|-|-
`state_change`|`{ current, previous }`|
`workflow_update`||Internal state updated, such as when a message is added
`workflow_end`|`{ reason }`|reason: "complete", "cancel", or "error"
`child_workflow_begin`|`Workflow`|The payload is the child workflow
`child_workflow_event`|`{ event_name, event_args }`|Bubbles child workflow events up to the parent workflow
`message_queued`|`string`|
`message_dequeued`|`string`|
`queue_cleared`||
`lifecycle_error`|`{ error, operation, context? }`|Infrastructure or lifecycle failure
`dispose`||

### WorkflowManager Events

Event|Payload Type|Notes
-|-|-
`state_change`|`{ current, previous }`|
`workflow_begin`|`Workflow`|Emitted on first prompt
`workflow_event`|`{ event_name, event_args }`|
`lifecycle_error`|`{ error, operation, context? }`|Infrastructure or lifecycle failure
`dispose`||
