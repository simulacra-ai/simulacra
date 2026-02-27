import type { ToolClass } from "@simulacra-ai/core";
export { BackgroundTaskPool } from "./background-task-pool.ts";
export { ParallelAgentTask } from "./parallel-agent-task.ts";
export { SubagentTask } from "./subagent-task.ts";
import { BackgroundTaskPool } from "./background-task-pool.ts";
import { ParallelAgentTask } from "./parallel-agent-task.ts";
import { SubagentTask } from "./subagent-task.ts";

/**
 * All orchestration tools as a ready-to-use toolkit.
 */
export const OrchestrationToolkit: ToolClass[] = [
  SubagentTask,
  ParallelAgentTask,
  BackgroundTaskPool,
];
