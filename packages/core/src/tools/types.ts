import type { Conversation } from "../conversations/index.ts";
import type { Workflow } from "../workflows/index.ts";

/**
 * Context provided to tools when they are executed.
 *
 * This interface can be extended with custom properties by passing
 * additional data through the workflow's context_data.
 */
export interface ToolContext {
  /** The conversation instance where the tool is being executed. */
  conversation: Conversation;
  /** The workflow instance managing the tool execution. */
  workflow: Workflow;
  /** Additional custom context properties. */
  [key: string]: unknown;
}

/**
 * Result indicating successful tool execution.
 */
export interface ToolSuccessResult {
  result: true;
}

/**
 * Result indicating failed tool execution.
 */
export interface ToolErrorResult {
  result: false;
  /** Description of what went wrong. */
  message: string;
  /** Optional underlying error object. */
  error?: unknown;
}

/**
 * Union of all possible tool execution results.
 */
export type ToolResult = ToolSuccessResult | ToolErrorResult;

/**
 * String parameter type definition.
 */
export type StringParameterType =
  | {
      type: "string";
      required: true;
      default?: never;
      description?: string;
    }
  | {
      type: "string";
      required?: false;
      default?: string;
      description?: string;
    };

/**
 * Enumeration parameter type definition.
 */
export type EnumParameterType =
  | {
      type: "string";
      required: true;
      enum: string[];
      default?: never;
      description?: string;
    }
  | {
      type: "string";
      required?: false;
      enum: string[];
      default?: string;
      description?: string;
    };

/**
 * Number parameter type definition.
 */
export type NumberParameterType =
  | {
      type: "number";
      required: true;
      default?: never;
      description?: string;
    }
  | {
      type: "number";
      required?: false;
      default?: number;
      description?: string;
    };

/**
 * Boolean parameter type definition.
 */
export type BooleanParameterType =
  | {
      type: "boolean";
      required: true;
      default?: never;
      description?: string;
    }
  | {
      type: "boolean";
      required?: false;
      default?: boolean;
      description?: string;
    };

/**
 * Union of all primitive parameter types.
 */
export type PrimitiveParameterType =
  | StringParameterType
  | EnumParameterType
  | NumberParameterType
  | BooleanParameterType;

/**
 * Object parameter type definition with nested properties.
 */
export interface ObjectParameterType {
  type: "object";
  required?: boolean;
  properties: Record<string, ParameterType>;
  default?: never;
  description?: string;
}

/**
 * Array parameter type definition.
 */
export interface ArrayParameterType {
  type: "array";
  required?: boolean;
  items: ParameterType;
  default?: never;
  description?: string;
}

/**
 * Union of all parameter types.
 */
export type ParameterType = PrimitiveParameterType | ObjectParameterType | ArrayParameterType;

/**
 * A named parameter with its type definition and optional description.
 */
export type ToolParameterDefinition = ParameterType & {
  name: string;
  description?: string;
};

/**
 * Complete definition of a tool including its name, description, and parameters.
 */
export interface ToolDefinition {
  /** The unique name of the tool. */
  name: string;
  /** Description of what the tool does. */
  description: string;
  /** The parameters the tool accepts. */
  parameters: ToolParameterDefinition[];
  /** Whether this tool can be executed in parallel with other tools. */
  parallelizable?: boolean;
}

/**
 * Constructor interface for tool classes.
 *
 * @template TParams - The parameter type for the tool.
 * @template TSuccessResult - The success result type.
 * @template TErrorResult - The error result type.
 */
export interface ToolClass<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TSuccessResult extends ToolSuccessResult = ToolSuccessResult,
  TErrorResult extends ToolErrorResult = ToolErrorResult,
> {
  /**
   * Constructs a new tool instance.
   *
   * @param context - The context for tool execution.
   */
  new (context: ToolContext): Tool<TParams, TSuccessResult, TErrorResult>;

  /**
   * Gets the static definition of this tool.
   *
   * @returns The tool definition.
   */
  get_definition(): ToolDefinition;
}

/**
 * Interface that all tools must implement.
 *
 * @template TParams - The parameter type for the tool.
 * @template TSuccessResult - The success result type.
 * @template TErrorResult - The error result type.
 */
export interface Tool<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TSuccessResult extends ToolSuccessResult = ToolSuccessResult,
  TErrorResult extends ToolErrorResult = ToolErrorResult,
> {
  /**
   * Executes the tool with the provided parameters.
   *
   * @param params - The parameters for tool execution.
   * @returns A promise that resolves to either success or error result.
   */
  execute(params: TParams): Promise<TSuccessResult | TErrorResult>;
}
