# Simulacra Agent Orchestration

Multi-agent orchestration patterns for the Simulacra conversation engine. Child agents run independently with their own conversations and tool access.

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/orchestration
```

## Setup

All orchestration patterns require a `WorkflowManager` wrapping a conversation with tools:

```typescript
import { Conversation, WorkflowManager } from "@simulacra-ai/core";

const conversation = new Conversation(provider);
conversation.toolkit = [/* your tools */];
const workflowManager = new WorkflowManager(conversation);
```

## Usage

### SubagentOrchestrator

Spawns a child agent and blocks until it completes.

```typescript
import { SubagentOrchestrator } from "@simulacra-ai/orchestration";

const agent = new SubagentOrchestrator(workflowManager);
const result = await agent.execute("Analyze this data and report findings");

console.log(result.end_reason); // "complete" | "cancel" | "error"
console.log(result.messages);
```

### BackgroundOrchestrator

A single background worker. Call `execute` once to start, then inspect or collect.

```typescript
import { BackgroundOrchestrator } from "@simulacra-ai/orchestration";

using worker = new BackgroundOrchestrator(workflowManager);
worker.execute("Monitor the feed for changes");

// later
worker.status; // "running" | "completed" | "cancelled"
worker.done; // true when completed or cancelled
worker.rounds; // number of agentic turns
worker.tool_call_count; // total tool calls made
worker.latest_message; // last assistant text

const result = await worker.collect(); // await completion, get full result
worker.cancel(); // cancel if still running
// automatically disposed at end of scope
```

### BackgroundAgentPool

Manages multiple background workers with batch operations.

```typescript
import { BackgroundAgentPool } from "@simulacra-ai/orchestration";

using pool = new BackgroundAgentPool(workflowManager);

const id1 = pool.start("Research topic A");
const id2 = pool.start("Research topic B");
const id3 = pool.start("Research topic C");

pool.list(); // [id1, id2, id3]
pool.state(id1, id2); // WorkerState[] with status, rounds, tool_call_count, latest_message
pool.cancel(id2); // cancel a specific worker

const done = pool.ack(); // pop all completed workers, returns their states
// all remaining workers cancelled and cleaned up at end of scope
```

### ParallelOrchestrator

Runs multiple prompts concurrently and waits for all to complete.

```typescript
import { ParallelOrchestrator } from "@simulacra-ai/orchestration";

const agent = new ParallelOrchestrator(workflowManager);
const results = await agent.execute([
  { prompt: "Analyze dataset A" },
  { prompt: "Analyze dataset B" },
  { prompt: "Analyze dataset C", system: "Focus on outliers" },
]);
```

## LLM Tools

Each pattern is available as a `ToolClass` for model-driven orchestration.

> **Note:** By default, orchestration tools are stripped from child agents to prevent recursive nesting. Pass `strip_tools: false` to the `Orchestrator` constructor to allow it.

```typescript
import { OrchestrationToolkit } from "@simulacra-ai/orchestration";

conversation.toolkit = [...conversation.toolkit, ...OrchestrationToolkit];
```

Individual tools (`SubagentTask`, `BackgroundWorkerPool`, `ParallelAgentTask`) are also exported if you want to pick selectively.

`BackgroundWorkerPool` exposes a worker pool to the model with these actions:

Action|Description
-|-
`start`|Launch one or more background workers (requires `prompts`)
`list`|List all worker IDs
`state`|Get status, rounds, tool calls, latest message (optional `ids`)
`cancel`|Stop workers (requires `ids`)
`ack`|Pop completed workers and return their states (optional `ids`)

## License

MIT
