import type {
  Tool,
  ToolClass,
  ToolContext,
  ToolDefinition,
  ToolErrorResult,
  ToolSuccessResult,
} from "@simulacra-ai/core";
import { BackgroundAgentPool } from "../background-agent-pool.ts";
import { ORCHESTRATION_DEPTH_KEY } from "../orchestrator.ts";
import type { WorkerState } from "../types.ts";

type BackgroundParams = {
  action: "start" | "list" | "state" | "cancel" | "ack";
  prompts?: string[];
  system?: string;
  fork_session?: boolean;
  ids?: string[];
};

type BackgroundToolSuccess = ToolSuccessResult & {
  ids?: string[];
  workers?: WorkerState[];
};

class BackgroundTaskPoolImpl implements Tool<BackgroundParams, BackgroundToolSuccess> {
  readonly #pool: BackgroundAgentPool;

  constructor(context: ToolContext) {
    const POOL_KEY = "__background_agent_pool";
    if (!context[POOL_KEY]) {
      const depth = (context[ORCHESTRATION_DEPTH_KEY] as number) ?? 0;
      context[POOL_KEY] = new BackgroundAgentPool(context.workflow, { recursive_depth: depth });
    }
    const pool = context[POOL_KEY] as BackgroundAgentPool;
    pool.update_source(context.workflow);
    this.#pool = pool;
  }

  async execute({ action, prompts, system, fork_session, ids }: BackgroundParams) {
    try {
      switch (action) {
        case "start": {
          if (!prompts?.length) {
            return {
              result: false as const,
              message: "prompts is required for start",
            } as ToolErrorResult;
          }
          const started_ids = prompts.map((p) => this.#pool.start(p, { system, fork_session }));
          return { result: true as const, ids: started_ids };
        }
        case "list": {
          const worker_ids = this.#pool.list();
          return { result: true as const, ids: worker_ids };
        }
        case "state": {
          const workers = ids?.length ? this.#pool.state(...ids) : this.#pool.state();
          return { result: true as const, workers };
        }
        case "cancel": {
          if (!ids?.length) {
            return {
              result: false as const,
              message: "ids is required for cancel",
            } as ToolErrorResult;
          }
          const errors: string[] = [];
          for (const id of ids) {
            try {
              this.#pool.cancel(id);
            } catch (e) {
              errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          if (errors.length) {
            return {
              result: false as const,
              message: `some cancels failed: ${errors.join("; ")}`,
            } as ToolErrorResult;
          }
          return { result: true as const, ids };
        }
        case "ack": {
          const workers = ids?.length ? this.#pool.ack(...ids) : this.#pool.ack();
          return { result: true as const, workers };
        }
        default: {
          return {
            result: false as const,
            message: `unknown action: ${action}`,
          } as ToolErrorResult;
        }
      }
    } catch (error) {
      return {
        result: false as const,
        message: error instanceof Error ? error.message : String(error),
        error,
      } as ToolErrorResult;
    }
  }

  static get_definition(): ToolDefinition {
    return {
      name: "background",
      description:
        "Manage background worker agents. Workers run independently with their own " +
        "conversations and tools. Use 'start' to launch workers, 'list' to see all " +
        "worker IDs, 'state' to check progress (rounds, tool calls, latest message), " +
        "'cancel' to stop workers, 'ack' to collect results from completed workers " +
        "and remove them from the pool.",
      parameters: [
        {
          name: "action",
          description: "The operation to perform",
          type: "string",
          required: true,
          enum: ["start", "list", "state", "cancel", "ack"],
        },
        {
          name: "prompts",
          description:
            "Instructions for workers to start, one per worker. Required and must not be empty when action is 'start'.",
          type: "array",
          required: false,
          items: { type: "string", required: true },
        },
        {
          name: "system",
          description: "Override the system prompt (only for 'start')",
          type: "string",
          required: false,
        },
        {
          name: "fork_session",
          description: "Start with current conversation history (only for 'start')",
          type: "boolean",
          required: false,
        },
        {
          name: "ids",
          description: "Worker IDs to operate on (for 'state', 'cancel', 'ack'). Omit for all.",
          type: "array",
          required: false,
          items: { type: "string", required: true },
        },
      ],
      parallelizable: false,
    };
  }
}

/**
 * Tool that lets a model manage a pool of background worker agents. Supports
 * starting tasks, listing workers, checking state, cancelling, and collecting
 * results without blocking the main conversation.
 */
export const BackgroundTaskPool: ToolClass<BackgroundParams, BackgroundToolSuccess> =
  BackgroundTaskPoolImpl;
