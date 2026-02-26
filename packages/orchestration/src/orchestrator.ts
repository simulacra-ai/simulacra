import { Workflow, WorkflowManager } from "@simulacra-ai/core";
import type { Conversation, ToolClass } from "@simulacra-ai/core";
import type { BackgroundHandle, SubagentOptions, SubagentResult } from "./types.ts";

const ORCHESTRATION_TOOL_NAMES = new Set(["subagent", "background", "parallel"]);

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
 * By default, orchestration tools are stripped from child agents to
 * prevent nesting. Pass `strip_tools: false` to allow it.
 */
export abstract class Orchestrator {
  readonly #manager?: WorkflowManager;
  readonly #workflow?: Workflow;
  readonly #strip_tools: boolean;

  /**
   * @param source - A `WorkflowManager` or `Workflow` to spawn children from.
   * @param options.strip_tools - Remove orchestration tools from child agents. Defaults to `true`.
   */
  constructor(source: WorkflowManager | Workflow, { strip_tools = true } = {}) {
    if (source instanceof WorkflowManager) {
      this.#manager = source;
    } else {
      this.#workflow = source;
    }
    this.#strip_tools = strip_tools;
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
   * tools unless disabled), and starts the workflow. Returns a handle
   * for awaiting, inspecting, or cancelling the child.
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
    child.toolkit = this.#strip_tools ? strip_orchestration_tools(toolkit) : toolkit;

    const parent = this.parent_workflow;
    const child_workflow =
      parent && parent.state !== "disposed"
        ? parent.spawn_child(child, options?.id)
        : new Workflow(child);

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
