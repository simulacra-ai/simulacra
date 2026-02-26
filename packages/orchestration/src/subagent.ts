import { Orchestrator } from "./orchestrator.ts";
import type { SubagentOptions, SubagentResult } from "./types.ts";

/**
 * Spawns a child agent and blocks until it completes.
 *
 * The child runs its own agentic loop with access to the parent's tools
 * (minus orchestration tools).
 */
export class SubagentOrchestrator extends Orchestrator {
  /**
   * Run a prompt as an autonomous child agent and return when it completes.
   *
   * @param prompt - The instruction for the child agent.
   * @param options - Configuration for the child agent (system prompt, tools, session forking, custom ID).
   */
  async execute(prompt: string, options?: SubagentOptions): Promise<SubagentResult> {
    return this.spawn(prompt, options).promise;
  }
}
