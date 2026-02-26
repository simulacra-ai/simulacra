import type {
  Tool,
  ToolClass,
  ToolContext,
  ToolDefinition,
  ToolErrorResult,
  ToolSuccessResult,
} from "@simulacra-ai/core";
import { ParallelOrchestrator } from "../parallel-agent.ts";
import { extract_response } from "./utils.ts";

type ParallelParams = {
  prompts: string[];
  system?: string;
  fork_session?: boolean;
};

type ParallelToolSuccess = ToolSuccessResult & {
  responses: Array<{
    id: string;
    response: string;
    end_reason: string;
  }>;
};

class ParallelAgentTaskImpl implements Tool<ParallelParams, ParallelToolSuccess> {
  readonly #agent: ParallelOrchestrator;

  constructor(context: ToolContext) {
    this.#agent = new ParallelOrchestrator(context.workflow);
  }

  async execute({ prompts, system, fork_session }: ParallelParams) {
    try {
      if (!prompts?.length) {
        return {
          result: false as const,
          message: "prompts is required and must not be empty",
        } as ToolErrorResult;
      }
      const tasks = prompts.map((prompt) => ({ prompt, system, fork_session }));
      const results = await this.#agent.execute(tasks);
      return {
        result: true as const,
        responses: results.map((r) => ({
          id: r.id,
          response: extract_response(r),
          end_reason: r.end_reason,
        })),
      };
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
      name: "parallel",
      description:
        "Run multiple prompts as concurrent sub-agents. All agents start immediately " +
        "and the tool returns when every agent has completed. Each sub-agent has its " +
        "own conversation and access to the same tools. Use when tasks are independent " +
        "and can benefit from concurrent execution.",
      parameters: [
        {
          name: "prompts",
          description: "Array of instructions, one per sub-agent",
          type: "array",
          required: true,
          items: { type: "string", required: true },
        },
        {
          name: "system",
          description: "Override the system prompt for all sub-agents",
          type: "string",
          required: false,
        },
        {
          name: "fork_session",
          description: "If true, each sub-agent starts with the current conversation history",
          type: "boolean",
          required: false,
        },
      ],
      parallelizable: false,
    };
  }
}

export const ParallelAgentTask: ToolClass<ParallelParams, ParallelToolSuccess> =
  ParallelAgentTaskImpl;
