import { Orchestrator } from "./orchestrator.ts";
import type { BackgroundHandle, SubagentOptions, SubagentResult } from "./types.ts";

/**
 * Runs multiple prompts concurrently, each as an independent child agent.
 * Returns when all complete.
 */
export class ParallelOrchestrator extends Orchestrator {
  /**
   * Run all tasks concurrently and return when every child agent has completed.
   *
   * @param tasks - Array of task configs, each with a `prompt` and optional `SubagentOptions`.
   */
  async execute(tasks: Array<{ prompt: string } & SubagentOptions>): Promise<SubagentResult[]> {
    const handles: BackgroundHandle[] = [];
    try {
      for (const { prompt, ...options } of tasks) {
        handles.push(this.spawn(prompt, options));
      }
    } catch (error) {
      for (const handle of handles) {
        try {
          handle.cancel();
        } catch {
          /* ignore */
        }
      }
      throw error;
    }
    return Promise.all(handles.map((h) => h.promise));
  }
}
