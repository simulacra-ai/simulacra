# Simulacra Agent Orchestration

The orchestration package provides multi-agent patterns for Simulacra. Real workloads often call for delegation, parallelism, or long-running background tasks. Each worker agent gets its own conversation and tool access, and the orchestrator manages spawning, cancellation, and result collection.

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/orchestration
```

## Setup

All orchestration patterns build on top of a `WorkflowManager`. The orchestrator spawns child conversations from the parent, so each worker agent inherits the provider, tools, and system prompt.

```typescript
// create a conversation and workflow manager
using conversation = new Conversation(provider);
conversation.toolkit = [/* tools */];
using workflowManager = new WorkflowManager(conversation);
```

## Patterns

Each pattern can be used in two ways. As a tool added to a conversation's toolkit, letting the model decide when and how to delegate. Or as a direct API call from application code for explicit control over orchestration.

### SubagentOrchestrator

The simplest pattern. Spawns a child agent, blocks until it completes, and returns the result.

```typescript
// spawn a subagent and wait for it to finish
const agent = new SubagentOrchestrator(workflowManager);
const result = await agent.execute("Analyze this data and report findings");

console.log(result.end_reason); 
console.log(result.messages);
```

### ParallelOrchestrator

Fans out multiple prompts concurrently and waits for all of them to complete. Each prompt gets its own agent, and all results are returned together.

```typescript
// fan out three tasks in parallel
const agent = new ParallelOrchestrator(workflowManager);
const results = await agent.execute([
  { prompt: "Analyze dataset A" },
  { prompt: "Analyze dataset B" },
  { prompt: "Analyze dataset C", system: "Focus on outliers" },
]);
```

### BackgroundOrchestrator

A background worker that runs independently. Start it with `execute`, then check on it or collect results later.

```typescript
// start a background worker
using worker = new BackgroundOrchestrator(workflowManager);
worker.execute("Monitor the feed for changes");

// check on it later
setTimeout(() => {
  console.log(worker.status); 
}, 5000);

// wait for it to finish and get the full result
const result = await worker.collect();
```

### BackgroundAgentPool

Manages multiple background workers with batch operations. Useful for parallelizing independent research or processing tasks where each worker runs on its own.

```typescript
// create a pool and start some workers
using pool = new BackgroundAgentPool(workflowManager);

pool.start("Research topic A");
pool.start("Research topic B");
pool.start("Research topic C");

// wait, then collect completed workers
setTimeout(() => {
  const done = pool.ack();
}, 30000);
```

### Recursive Depth

All three constructors (`SubagentOrchestrator`, `ParallelOrchestrator`, `BackgroundAgentPool`) accept a `{ recursive_depth }` option that controls how many levels of nested delegation the spawned agents are allowed to perform.

```typescript
const agent = new SubagentOrchestrator(workflowManager, { recursive_depth: 2 });
```

## Agentic Orchestration

Orchestration patterns are also available as task tools that can be added to a model's toolkit, allowing the model to decide when and how to delegate work.

```typescript
// give the model access to all orchestration tools
conversation.toolkit = [...conversation.toolkit, ...OrchestrationToolkit];

// give the model access to specific tools
conversation.toolkit = [...conversation.toolkit, SubagentTask, ParallelAgentTask, BackgroundTaskPool];
```

By default, spawned agents cannot delegate further. Nested delegation can be enabled by setting `ORCHESTRATION_DEPTH_KEY` in `context_data`.

```typescript
import { ORCHESTRATION_DEPTH_KEY } from "@simulacra-ai/orchestration";

// allows one level of nested delegation (agent > subagent > sub-subagent)
using manager = new WorkflowManager(conversation, {
  context_data: { [ORCHESTRATION_DEPTH_KEY]: 1 },
});
```


## License

MIT
