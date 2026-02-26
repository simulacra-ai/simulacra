import type { ToolClass } from "@simulacra-ai/core";
export { SubagentTask } from "./subagent-task.ts";
export { BackgroundWorkerPool } from "./background-worker-pool.ts";
export { ParallelAgentTask } from "./parallel-agent-task.ts";

import { SubagentTask } from "./subagent-task.ts";
import { BackgroundWorkerPool } from "./background-worker-pool.ts";
import { ParallelAgentTask } from "./parallel-agent-task.ts";

/**
 * All orchestration tools (`SubagentTask`, `BackgroundWorkerPool`, `ParallelAgentTask`) as a ready-to-use toolkit.
 */
export const OrchestrationToolkit: ToolClass[] = [
  SubagentTask,
  BackgroundWorkerPool,
  ParallelAgentTask,
];
