import { Workflow, WorkflowManager } from "@simulacra-ai/core";
import type { Conversation, ToolClass } from "@simulacra-ai/core";
import type { BackgroundHandle, SubagentOptions, SubagentResult } from "./types.ts";

const ORCHESTRATION_TOOL_NAMES = new Set(["subagent", "background", "parallel"]);

/**
 * Context key used to propagate the remaining orchestration depth to child agents.
 */
export const ORCHESTRATION_DEPTH_KEY = "__orchestration_depth";

/**
 * Remove orchestration tools from a toolkit to prevent child agents from nesting.
 *
 * @param toolkit - The toolkit to filter.
 */
function strip_orchestration_tools(toolkit: ToolClass[]): ToolClass[] {
  return toolkit.filter((t) => !ORCHESTRATION_TOOL_NAMES.has(t.get_definition().name));
}

/**
 * Base class for orchestration patterns.
 *
 * Accepts a `WorkflowManager` (for programmatic use) or a `Workflow`
 * (for tool integration). Provides the shared child-spawning logic
 * that all orchestration patterns build on.
 *
 * By default, `recursive_depth` is `0`, which strips orchestration tools
 * from child agents to prevent nesting. Set to a positive number to allow
 * that many levels of recursive orchestration, or `-1` for unlimited depth.
 */
export abstract class Orchestrator {
  readonly #manager?: WorkflowManager;
  readonly #workflow?: Workflow;
  readonly #recursive_depth: number;

  /**
   * @param source - A `WorkflowManager` or `Workflow` to spawn children from.
   * @param options.recursive_depth - How many levels of recursive orchestration to allow. `0` (default) strips orchestration tools from children, `-1` allows unlimited nesting.
   */
  constructor(source: WorkflowManager | Workflow, { recursive_depth = 0 } = {}) {
    if (!Number.isInteger(recursive_depth) || recursive_depth < -1) {
      throw new Error("invalid value for recursive_depth");
    }
    if (source instanceof WorkflowManager) {
      this.#manager = source;
    } else {
      this.#workflow = source;
    }
    this.#recursive_depth = recursive_depth;
  }

  /**
   * The conversation associated with the orchestrator.
   */
  protected get conversation(): Conversation {
    if (this.#manager) {
      return this.#manager.conversation;
    }
    if (this.#workflow) {
      return this.#workflow.conversation;
    }
    throw new Error("no source");
  }

  /**
   * The parent workflow, if available. Used to establish parent-child workflow relationships.
   */
  protected get parent_workflow(): Workflow | undefined {
    if (this.#manager) {
      return this.#manager.current_workflow;
    }
    return this.#workflow;
  }

  /**
   * Spawn a child agent with its own conversation and workflow.
   *
   * Creates a child conversation, assigns tools (stripping orchestration
   * tools when depth is exhausted), and starts the workflow. Returns a
   * handle for awaiting, inspecting, or cancelling the child.
   *
   * @param prompt - The instruction to send to the child agent.
   * @param options - Configuration for the child agent (system prompt, tools, session forking, custom ID).
   */
  protected spawn(prompt: string, options?: SubagentOptions): BackgroundHandle {
    const conversation = this.conversation;
    const child = conversation.spawn_child(
      options?.fork_session,
      options?.id,
      options?.system ?? conversation.system,
    );
    const toolkit = options?.toolkit ?? [...conversation.toolkit];
    child.toolkit = this.#recursive_depth === 0 ? strip_orchestration_tools(toolkit) : toolkit;

    const next_depth = this.#recursive_depth === -1 ? -1 : Math.max(0, this.#recursive_depth - 1);
    const child_context = { [ORCHESTRATION_DEPTH_KEY]: next_depth };

    const parent = this.parent_workflow;
    const child_workflow =
      parent && parent.state !== "disposed"
        ? parent.spawn_child(child, options?.id, child_context)
        : new Workflow(child, { context_data: child_context });

    let settled = false;

    const promise = new Promise<SubagentResult>((resolve) => {
      child_workflow.once("workflow_end", (event) => {
        settled = true;
        resolve({
          id: child_workflow.id,
          messages: child_workflow.messages,
          end_reason: event.reason,
        });
        if (child.state !== "disposed") {
          child[Symbol.dispose]();
        }
      });

      try {
        child_workflow.start();
        child.prompt(prompt);
      } catch {
        if (!settled) {
          settled = true;
          resolve({
            id: child_workflow.id,
            messages: child_workflow.messages,
            end_reason: "cancel",
          });
          if (child.state !== "disposed") {
            child[Symbol.dispose]();
          }
        }
      }
    });

    return {
      get id() {
        return child_workflow.id;
      },
      get workflow() {
        return child_workflow;
      },
      promise,
      get done() {
        return settled;
      },
      cancel: () => child_workflow.cancel(),
    };
  }
}
