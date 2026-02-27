import { Orchestrator } from "./orchestrator.ts";
import type { BackgroundHandle, SubagentOptions, SubagentResult, WorkerState } from "./types.ts";

/**
 * A single background worker agent.
 *
 * Each instance represents one background task. Call `execute` once to
 * start it, then use `status`, `done`, `collect`, and `cancel` to manage it.
 */
export class BackgroundOrchestrator extends Orchestrator {
  #handle?: BackgroundHandle;
  #status: "idle" | "running" | "completed" | "cancelled" = "idle";

  /**
   * Start the background worker. Can only be called once.
   *
   * @param prompt - The instruction for the worker.
   * @param options - Configuration for the worker (system prompt, tools, session forking, custom ID).
   */
  execute(prompt: string, options?: SubagentOptions): void {
    if (this.#status !== "idle") {
      throw new Error("invalid state");
    }
    this.#handle = this.spawn(prompt, options);
    this.#status = "running";
    this.#handle.promise.then(() => {
      if (this.#status === "running") {
        this.#status = "completed";
      }
    });
  }

  /**
   * The unique identifier of this worker. Throws if not started.
   */
  get id(): string {
    if (!this.#handle) {
      throw new Error("not started");
    }
    return this.#handle.id;
  }

  /**
   * Current state: `idle`, `running`, `completed`, or `cancelled`.
   */
  get status() {
    return this.#status;
  }

  /**
   * `true` when the worker has completed or been cancelled.
   */
  get done(): boolean {
    return this.#status === "completed" || this.#status === "cancelled";
  }

  /**
   * Number of agentic turns (assistant messages) so far.
   */
  get rounds(): number {
    if (!this.#handle) {
      return 0;
    }
    return this.#handle.workflow.messages.filter((m) => m.role === "assistant").length;
  }

  /**
   * Total number of tool calls made across all rounds.
   */
  get tool_call_count(): number {
    if (!this.#handle) {
      return 0;
    }
    return this.#handle.workflow.messages
      .filter((m) => m.role === "assistant")
      .reduce((count, m) => count + m.content.filter((c) => c.type === "tool").length, 0);
  }

  /**
   * The text content of the most recent assistant message, if any.
   */
  get latest_message(): string | undefined {
    if (!this.#handle) {
      return undefined;
    }
    const messages = this.#handle.workflow.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        const text = msg.content?.find((c) => c.type === "text");
        if (text?.type === "text") {
          return text.text;
        }
      }
    }
    return undefined;
  }

  /**
   * Snapshot of the worker's current state.
   */
  get_state(): WorkerState {
    if (this.#status === "idle") {
      return {
        id: "",
        status: "idle",
        rounds: 0,
        tool_call_count: 0,
      };
    }
    return {
      id: this.id,
      status: this.#status,
      rounds: this.rounds,
      tool_call_count: this.tool_call_count,
      latest_message: this.latest_message,
    };
  }

  /**
   * Await completion and return the full result.
   */
  async collect(): Promise<SubagentResult> {
    if (!this.#handle) {
      throw new Error("not started");
    }
    return this.#handle.promise;
  }

  /**
   * Cancel the running worker. Throws if not running.
   */
  cancel(): void {
    if (this.#status !== "running" || !this.#handle) {
      throw new Error("invalid state");
    }
    if (this.#handle.workflow.state !== "disposed") {
      this.#handle.cancel();
    }
    this.#status = "cancelled";
  }

  /**
   * Dispose the worker, cancelling it if still running.
   */
  [Symbol.dispose](): void {
    if (this.#status === "running" && this.#handle) {
      if (this.#handle.workflow.state !== "disposed") {
        this.#handle.cancel();
      }
      this.#status = "cancelled";
    }
    this.#handle = undefined;
  }
}
