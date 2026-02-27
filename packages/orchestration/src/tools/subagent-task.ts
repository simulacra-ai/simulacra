import type {
  Tool,
  ToolClass,
  ToolContext,
  ToolDefinition,
  ToolErrorResult,
  ToolSuccessResult,
} from "@simulacra-ai/core";
import { ORCHESTRATION_DEPTH_KEY } from "../orchestrator.ts";
import { SubagentOrchestrator } from "../subagent.ts";
import { extract_response } from "./utils.ts";

type SubagentParams = {
  prompt: string;
  system?: string;
  fork_session?: boolean;
};

type SubagentToolSuccess = ToolSuccessResult & {
  id: string;
  response: string;
  end_reason: string;
};

class SubagentTaskImpl implements Tool<SubagentParams, SubagentToolSuccess> {
  readonly #agent: SubagentOrchestrator;

  constructor(context: ToolContext) {
    const depth = (context[ORCHESTRATION_DEPTH_KEY] as number) ?? 0;
    this.#agent = new SubagentOrchestrator(context.workflow, { recursive_depth: depth });
  }

  async execute({ prompt, system, fork_session }: SubagentParams) {
    try {
      const result = await this.#agent.execute(prompt, { system, fork_session });
      return {
        result: true as const,
        id: result.id,
        response: extract_response(result),
        end_reason: result.end_reason,
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
      name: "subagent",
      description:
        "Run a prompt as an autonomous sub-agent with its own conversation. " +
        "The sub-agent has access to the same tools and runs to completion, " +
        "returning its final response. Use for tasks that require independent " +
        "multi-step reasoning or tool use.",
      parameters: [
        {
          name: "prompt",
          description: "The instruction for the sub-agent",
          type: "string",
          required: true,
        },
        {
          name: "system",
          description: "Override the system prompt for this sub-agent",
          type: "string",
          required: false,
        },
        {
          name: "fork_session",
          description:
            "If true, the sub-agent starts with a copy of the current conversation history",
          type: "boolean",
          required: false,
        },
      ],
      parallelizable: true,
    };
  }
}

/**
 * Tool that lets a model spawn an autonomous subagent with its own conversation
 * to handle a subtask independently. The subagent runs to completion and returns
 * its final response.
 */
export const SubagentTask: ToolClass<SubagentParams, SubagentToolSuccess> = SubagentTaskImpl;
