import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @simulacra-ai/core
//
// The orchestration classes depend on Workflow and WorkflowManager from core.
// vi.mock is hoisted, so the factory cannot reference top-level variables
// declared after the call. We build the fakes inline inside the factory.
// ---------------------------------------------------------------------------

interface FakeConversation {
  system?: string;
  toolkit: { get_definition(): { name: string } }[];
  messages: unknown[];
  state: string;
  spawn_child: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  [Symbol.dispose]: ReturnType<typeof vi.fn>;
}

function create_mock_conversation(
  options: {
    toolkit?: { get_definition(): { name: string } }[];
    system?: string;
  } = {},
): FakeConversation {
  const conv: FakeConversation = {
    system: options.system ?? "You are helpful.",
    toolkit: options.toolkit ?? [],
    messages: [],
    state: "idle",
    spawn_child: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    [Symbol.dispose]: vi.fn(),
  };
  conv.spawn_child.mockImplementation(() => {
    return create_mock_conversation({ toolkit: [...conv.toolkit] });
  });
  return conv;
}

// Use vi.hoisted so the class is available when vi.mock's factory runs
const { FakeWorkflow, FakeWorkflowManager } = vi.hoisted(() => {
  // Dynamic import is not allowed in vi.hoisted, so we use require
  // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
  const { EventEmitter: EE } = require("node:events");

  class FakeWorkflow {
    id = "wf-" + Math.random().toString(36).slice(2, 8);
    _state: "idle" | "busy" | "disposed" = "idle";
    _emitter = new EE();
    _messages: unknown[] = [];
    conversation: unknown;

    constructor(conversation?: unknown, _options?: Record<string, unknown>) {
      this.conversation = conversation ?? {};
    }

    get state() {
      return this._state;
    }

    get messages() {
      return Object.freeze([...this._messages]);
    }

    once(event: string, handler: (...args: unknown[]) => void) {
      this._emitter.once(event, handler);
      return this;
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      this._emitter.on(event, handler);
      return this;
    }

    off(event: string, handler: (...args: unknown[]) => void) {
      this._emitter.off(event, handler);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      this._emitter.emit(event, ...args);
    }

    start() {
      this._state = "busy";
    }

    cancel() {
      this._state = "disposed";
      this._emitter.emit("workflow_end", { reason: "cancel" }, this);
    }

    spawn_child(
      conversation: unknown,
      id?: string,
      context_data?: Record<string, unknown>,
    ): FakeWorkflow {
      const child = new FakeWorkflow(conversation, { context_data, parent: this });
      if (id) {
        child.id = id;
      }
      return child;
    }

    [Symbol.dispose]() {
      this._state = "disposed";
      this._emitter.removeAllListeners();
    }
  }

  class FakeWorkflowManager {}

  return { FakeWorkflow, FakeWorkflowManager };
});

vi.mock("@simulacra-ai/core", () => ({
  Workflow: FakeWorkflow,
  WorkflowManager: FakeWorkflowManager,
}));

// ---------------------------------------------------------------------------
// Import orchestration classes under test (after mock is registered)
// ---------------------------------------------------------------------------
import { SubagentOrchestrator } from "../subagent.ts";
import { BackgroundOrchestrator } from "../background-agent.ts";
import { BackgroundAgentPool } from "../background-agent-pool.ts";
import { ParallelOrchestrator } from "../parallel-agent.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a FakeWorkflow whose spawn_child is spied on. This lets tests
 * inspect the child workflows created during orchestration.
 */
function create_parent_workflow(conversation: FakeConversation) {
  const parentWorkflow = new FakeWorkflow(conversation);
  parentWorkflow.start();

  const originalSpawnChild = parentWorkflow.spawn_child.bind(parentWorkflow);
  vi.spyOn(parentWorkflow, "spawn_child").mockImplementation(
    (childConv: unknown, id?: string, contextData?: Record<string, unknown>) => {
      return originalSpawnChild(childConv, id, contextData);
    },
  );

  return parentWorkflow;
}

/**
 * Retrieve the most recently spawned child workflow from a parent and emit
 * workflow_end to resolve the orchestrator promise.
 */
function complete_spawned_child(parentWorkflow: InstanceType<typeof FakeWorkflow>) {
  const spawnMock = vi.mocked(parentWorkflow.spawn_child);
  const lastResult = spawnMock.mock.results[spawnMock.mock.results.length - 1];
  if (lastResult && lastResult.type === "return") {
    const child = lastResult.value as InstanceType<typeof FakeWorkflow>;
    child.emit("workflow_end", { reason: "complete" }, child);
    return child;
  }
  throw new Error("No child workflow was spawned");
}

/**
 * Retrieve the spawned child workflow at a specific index and emit
 * workflow_end to resolve its orchestrator promise.
 */
function complete_spawned_child_at(
  parentWorkflow: InstanceType<typeof FakeWorkflow>,
  index: number,
) {
  const spawnMock = vi.mocked(parentWorkflow.spawn_child);
  const result = spawnMock.mock.results[index];
  if (result && result.type === "return") {
    const child = result.value as InstanceType<typeof FakeWorkflow>;
    child.emit("workflow_end", { reason: "complete" }, child);
    return child;
  }
  throw new Error(`No child workflow at index ${index}`);
}

// ---------------------------------------------------------------------------
// BackgroundAgentPool
// ---------------------------------------------------------------------------
describe("BackgroundAgentPool", () => {
  let conversation: FakeConversation;
  let parentWorkflow: InstanceType<typeof FakeWorkflow>;

  beforeEach(() => {
    conversation = create_mock_conversation();
    parentWorkflow = create_parent_workflow(conversation);
  });

  it("registers a worker and queries it by id", () => {
    const pool = new BackgroundAgentPool(parentWorkflow as never);
    const id = pool.start("do something");

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const states = pool.state(id);
    expect(states).toHaveLength(1);
    expect(states[0].id).toBe(id);
  });

  it("acknowledges a completed worker (removes from active, adds to completed)", async () => {
    const pool = new BackgroundAgentPool(parentWorkflow as never);
    const id = pool.start("do something");

    // Worker is running so ack should skip it
    const beforeAck = pool.ack(id);
    expect(beforeAck).toHaveLength(0);
    expect(pool.list()).toContain(id);

    // Complete the child workflow
    complete_spawned_child(parentWorkflow);

    // Allow microtask (.then in BackgroundOrchestrator.execute) to settle
    await vi.waitFor(() => {
      const s = pool.state(id);
      expect(s[0].status).toBe("completed");
    });

    const acked = pool.ack(id);
    expect(acked).toHaveLength(1);
    expect(acked[0].id).toBe(id);
    expect(acked[0].status).toBe("completed");

    // Worker should no longer be listed
    expect(pool.list()).not.toContain(id);
  });

  it("lists active workers", () => {
    const pool = new BackgroundAgentPool(parentWorkflow as never);
    const id1 = pool.start("task one");
    const id2 = pool.start("task two");

    const listed = pool.list();
    expect(listed).toContain(id1);
    expect(listed).toContain(id2);
    expect(listed).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// SubagentOrchestrator
// ---------------------------------------------------------------------------
describe("SubagentOrchestrator", () => {
  let conversation: FakeConversation;
  let parentWorkflow: InstanceType<typeof FakeWorkflow>;

  beforeEach(() => {
    conversation = create_mock_conversation();
    parentWorkflow = create_parent_workflow(conversation);
  });

  it("spawns child conversation and returns messages on completion", async () => {
    const orchestrator = new SubagentOrchestrator(parentWorkflow as never);
    const executePromise = orchestrator.execute("summarize this");

    const childWorkflow = complete_spawned_child(parentWorkflow);

    const result = await executePromise;
    expect(result.id).toBe(childWorkflow.id);
    expect(result.end_reason).toBe("complete");
    expect(Array.isArray(result.messages)).toBe(true);
  });

  it("passes the prompt to the child conversation", async () => {
    const orchestrator = new SubagentOrchestrator(parentWorkflow as never);
    const executePromise = orchestrator.execute("analyze the data");

    // The parent conversation's spawn_child was called, producing a child conversation
    const childConv = conversation.spawn_child.mock.results[0].value as FakeConversation;
    expect(childConv.prompt).toHaveBeenCalledWith("analyze the data");

    complete_spawned_child(parentWorkflow);
    await executePromise;
  });
});

// ---------------------------------------------------------------------------
// BackgroundOrchestrator
// ---------------------------------------------------------------------------
describe("BackgroundOrchestrator", () => {
  let conversation: FakeConversation;
  let parentWorkflow: InstanceType<typeof FakeWorkflow>;

  beforeEach(() => {
    conversation = create_mock_conversation();
    parentWorkflow = create_parent_workflow(conversation);
  });

  it("initial state is idle", () => {
    const bg = new BackgroundOrchestrator(parentWorkflow as never);
    expect(bg.status).toBe("idle");
  });

  it("start transitions to running state", () => {
    const bg = new BackgroundOrchestrator(parentWorkflow as never);
    bg.execute("work on this");
    expect(bg.status).toBe("running");
  });

  it("cancel sets state to cancelled", () => {
    const bg = new BackgroundOrchestrator(parentWorkflow as never);
    bg.execute("work on this");
    expect(bg.status).toBe("running");

    // Grab the child workflow that was spawned and spy on its cancel method
    const spawnMock = vi.mocked(parentWorkflow.spawn_child);
    const childWorkflow = spawnMock.mock.results[0].value as InstanceType<typeof FakeWorkflow>;
    const cancelSpy = vi.spyOn(childWorkflow, "cancel");

    bg.cancel();
    expect(bg.status).toBe("cancelled");
    expect(cancelSpy).toHaveBeenCalledOnce();
  });

  it("strips orchestration tools from child toolkit at recursive_depth 0", () => {
    const regularTool = { get_definition: () => ({ name: "search" }) };
    const subagentTool = { get_definition: () => ({ name: "subagent" }) };
    const backgroundTool = { get_definition: () => ({ name: "background" }) };
    const parallelTool = { get_definition: () => ({ name: "parallel" }) };

    const convWithTools = create_mock_conversation({
      toolkit: [regularTool, subagentTool, backgroundTool, parallelTool],
    });
    const wf = create_parent_workflow(convWithTools);

    const bg = new BackgroundOrchestrator(wf as never, { recursive_depth: 0 });
    bg.execute("work on this");

    // The child conversation was created by spawn_child on the parent conversation
    const childConv = convWithTools.spawn_child.mock.results[0].value as FakeConversation;

    // Verify the toolkit was filtered to exclude orchestration tools
    const toolNames = childConv.toolkit.map((t) => t.get_definition().name);
    expect(toolNames).toContain("search");
    expect(toolNames).not.toContain("subagent");
    expect(toolNames).not.toContain("background");
    expect(toolNames).not.toContain("parallel");
  });
});

// ---------------------------------------------------------------------------
// ParallelOrchestrator
// ---------------------------------------------------------------------------
describe("ParallelOrchestrator", () => {
  let conversation: FakeConversation;
  let parentWorkflow: InstanceType<typeof FakeWorkflow>;

  beforeEach(() => {
    conversation = create_mock_conversation();
    parentWorkflow = create_parent_workflow(conversation);
  });

  it("runs multiple tasks concurrently and collects results", async () => {
    const orchestrator = new ParallelOrchestrator(parentWorkflow as never);
    const executePromise = orchestrator.execute([{ prompt: "task one" }, { prompt: "task two" }]);

    // Both child workflows should have been spawned
    const spawnMock = vi.mocked(parentWorkflow.spawn_child);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Complete both children
    complete_spawned_child_at(parentWorkflow, 0);
    complete_spawned_child_at(parentWorkflow, 1);

    const results = await executePromise;
    expect(results).toHaveLength(2);
    expect(results[0].end_reason).toBe("complete");
    expect(results[1].end_reason).toBe("complete");
  });

  it("returns results in input order", async () => {
    const orchestrator = new ParallelOrchestrator(parentWorkflow as never);
    const executePromise = orchestrator.execute([{ prompt: "first" }, { prompt: "second" }]);

    // Grab the child workflow IDs before completing
    const spawnMock = vi.mocked(parentWorkflow.spawn_child);
    const child0 = spawnMock.mock.results[0].value as InstanceType<typeof FakeWorkflow>;
    const child1 = spawnMock.mock.results[1].value as InstanceType<typeof FakeWorkflow>;

    // Complete in reverse order (second finishes before first)
    complete_spawned_child_at(parentWorkflow, 1);
    complete_spawned_child_at(parentWorkflow, 0);

    const results = await executePromise;
    expect(results).toHaveLength(2);
    // Results should match the input order, not the completion order
    expect(results[0].id).toBe(child0.id);
    expect(results[1].id).toBe(child1.id);
  });
});
