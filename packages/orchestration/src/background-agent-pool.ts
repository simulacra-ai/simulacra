import type { Workflow, WorkflowManager } from "@simulacra-ai/core";
import { BackgroundOrchestrator } from "./background-agent.ts";
import type { SubagentOptions, WorkerState } from "./types.ts";

/**
 * Manages a pool of background worker agents.
 *
 * Provides a registry for starting, listing, inspecting, cancelling,
 * and acknowledging (collecting + removing) completed workers.
 */
export class BackgroundAgentPool {
  #source: WorkflowManager | Workflow;
  readonly #agents = new Map<string, BackgroundOrchestrator>();

  /**
   * @param source - A `WorkflowManager` or `Workflow` to spawn workers from.
   */
  constructor(source: WorkflowManager | Workflow) {
    this.#source = source;
  }

  /**
   * Update the workflow/manager reference used to spawn new workers.
   * This must be called when a persisted pool is reused by a new workflow,
   * so that new workers are spawned from the current (live) workflow
   * instead of a previously disposed one.
   */
  update_source(source: WorkflowManager | Workflow): void {
    this.#source = source;
  }

  /**
   * Launch a new background worker and return its ID.
   *
   * @param prompt - The instruction for the worker.
   * @param options - Configuration for the worker (system prompt, tools, session forking, custom ID).
   */
  start(prompt: string, options?: SubagentOptions): string {
    const agent = new BackgroundOrchestrator(this.#source);
    agent.execute(prompt, options);
    this.#agents.set(agent.id, agent);
    return agent.id;
  }

  /**
   * Return all worker IDs in the pool.
   */
  list(): string[] {
    return [...this.#agents.keys()];
  }

  /**
   * Get state snapshots for the given worker IDs, or all workers if omitted.
   *
   * @param ids - Worker IDs to query. Omit to query all.
   */
  state(...ids: string[]): WorkerState[] {
    const target_ids = ids.length > 0 ? ids : [...this.#agents.keys()];
    return target_ids.map((id) => {
      const agent = this.#agents.get(id);
      if (!agent) {
        throw new Error(`no worker with id ${id}`);
      }
      return agent.get_state();
    });
  }

  /**
   * Cancel a running worker by ID.
   *
   * @param id - The worker ID to cancel.
   */
  cancel(id: string): void {
    const agent = this.#agents.get(id);
    if (!agent) {
      throw new Error(`no worker with id ${id}`);
    }
    agent.cancel();
  }

  /**
   * Pop completed workers from the pool and return their states. Skips workers still running.
   *
   * @param ids - Worker IDs to acknowledge. Omit to acknowledge all completed.
   */
  ack(...ids: string[]): WorkerState[] {
    const target_ids = ids.length > 0 ? ids : [...this.#agents.keys()];
    const results: WorkerState[] = [];
    for (const id of target_ids) {
      const agent = this.#agents.get(id);
      if (!agent) {
        continue;
      }
      if (!agent.done) {
        continue;
      }
      results.push(agent.get_state());
      this.#agents.delete(id);
    }
    return results;
  }

  /**
   * Dispose all workers in the pool, cancelling any that are still running.
   */
  [Symbol.dispose](): void {
    for (const agent of this.#agents.values()) {
      agent[Symbol.dispose]();
    }
    this.#agents.clear();
  }
}
