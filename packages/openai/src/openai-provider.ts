import { OpenAI } from "openai";

import type {
  AssistantContent,
  AssistantMessage,
  CancellationToken,
  CompletionResponseData,
  Content,
  Message,
  ModelProvider,
  ModelRequest,
  ParameterType,
  ProviderContextTransformer,
  StreamReceiver,
  ToolContent,
  ToolDefinition,
  Usage,
} from "@simulacra-ai/core";

type Prettify<T> = { [K in keyof T]: T[K] } & {};

const OPENAI_REASONING_DELTA_KEYS = ["reasoning", "reasoning_content", "thinking"] as const;

type OpenAIReasoningDeltaKey = (typeof OPENAI_REASONING_DELTA_KEYS)[number];
type OpenAICompletionDelta = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta;
type OpenAIReasoningDelta = OpenAICompletionDelta &
  Partial<Record<OpenAIReasoningDeltaKey, string>>;

/**
 * Configuration options for the OpenAI provider.
 */
export interface OpenAIProviderConfig extends Record<string, unknown> {
  /** The model identifier to use (e.g., "gpt-4", "o1-preview"). */
  model: string;
  /** The maximum number of tokens to generate in the response. */
  max_tokens?: number;
  /**
   * Which role to use for the system prompt.
   *
   * The OpenAI Chat Completions spec allows `system` (legacy / most providers)
   * and `developer` (introduced for o-series reasoning models). Most
   * OpenAI-compatible endpoints (DeepSeek, OpenRouter relays, Anthropic-via-
   * compat, self-hosted gateways, etc.) only accept `system` and reject
   * `developer` with a 400.
   *
   * - `"auto"` (default): use the built-in heuristic — `gpt*` → `"system"`,
   *   o-series (`o1`, `o3`, `o4`, ...) → `"developer"`, anything else →
   *   `"system"` (the broadly-compatible default).
   * - `"system"` / `"developer"`: force the role regardless of model id.
   */
  systemRole?: "auto" | "system" | "developer";
  /**
   * Whether to emit OpenAI's strict structured-output flag on tool
   * definitions (`function.strict: true`).
   *
   * `strict` is an OpenAI-specific extension that constrains tool arguments
   * to the supplied JSON Schema. Most non-OpenAI endpoints either ignore the
   * field or reject it.
   *
   * - `"auto"` (default): emit `strict: true` only for OpenAI models
   *   (`gpt*` or o-series). Other models get tool defs without `strict`.
   * - `"never"`: never emit `strict`.
   */
  strictTools?: "auto" | "never";
}

/**
 * Model provider implementation for OpenAI's chat completion models.
 *
 * This provider wraps the OpenAI SDK to provide streaming completions with
 * support for tool use and function calling. It handles message formatting,
 * content streaming, and usage tracking according to the ModelProvider
 * interface.
 *
 * Works against OpenAI directly as well as OpenAI-compatible endpoints
 * (DeepSeek, OpenRouter, self-hosted gateways, etc.). The default behaviour
 * picks `system` vs. `developer` for the system prompt and decides whether
 * to emit OpenAI's `strict` flag on tool defs based on the model id; both
 * can be overridden through `OpenAIProviderConfig.systemRole` and
 * `OpenAIProviderConfig.strictTools` for endpoints whose behaviour differs.
 */
export class OpenAIProvider implements ModelProvider {
  readonly #sdk: OpenAI;
  readonly #config: OpenAIProviderConfig;
  readonly context_transformers: ProviderContextTransformer[];

  /**
   * Creates a new OpenAI provider instance.
   *
   * @param sdk - The initialized OpenAI SDK client.
   * @param config - Configuration options for the provider.
   * @param context_transformers - Provider-level context transformers.
   */
  constructor(
    sdk: OpenAI,
    config: OpenAIProviderConfig,
    context_transformers: ProviderContextTransformer[] = [],
  ) {
    this.#sdk = sdk;
    this.#config = config;
    this.context_transformers = context_transformers;
  }

  /**
   * Executes a model request and streams the response through the provided receiver.
   *
   * @param request - The request containing messages, tools, and system prompt.
   * @param receiver - The receiver that handles streaming events.
   * @param cancellation - Token to signal cancellation of the request.
   * @returns A promise that resolves when the request completes.
   */
  async execute_request(
    request: ModelRequest,
    receiver: StreamReceiver,
    cancellation: CancellationToken,
  ): Promise<void> {
    const { model, max_tokens, systemRole, strictTools, ...api_extras } = this.#config;
    const emit_strict = resolve_strict_tools(model, strictTools);
    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      ...api_extras,
      model,
      stream: true,
      max_tokens,
      ...(request.tools.length > 0
        ? {
            tool_choice: "auto",
            tools: request.tools.map((t) => to_openai_tool(t, emit_strict)),
          }
        : {}),
      messages: [
        ...get_system_context(model, request.system, systemRole),
        ...request.messages.flatMap((m) => to_openai_messages(m)),
      ],
      stream_options: {
        include_usage: true,
      },
    };

    receiver.before_request({ params });
    receiver.request_raw(params);

    const stream = await this.#sdk.chat.completions.create(params);

    // Intentionally not awaited. Streaming is event-driven through the receiver.
    // The policy wraps only connection establishment; chunk processing flows
    // asynchronously via StreamListener events back to the conversation.
    this.#stream_response(stream, receiver, cancellation);
  }

  /**
   * Creates a clone of this provider with the same configuration.
   *
   * @returns A new provider instance with identical configuration.
   */
  clone(): ModelProvider {
    return new OpenAIProvider(this.#sdk, this.#config, this.context_transformers);
  }

  async #stream_response(
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
    receiver: StreamReceiver,
    cancellation: CancellationToken,
  ) {
    try {
      let response: OpenAI.Chat.Completions.ChatCompletionChunk | undefined;
      for await (const response_chunk of stream) {
        if (cancellation.is_cancellation_requested) {
          receiver.cancel();
          return;
        }
        receiver.stream_raw(response_chunk);

        const { choices: choices_chunk, ...rest } = response_chunk;
        response = {
          ...response,
          ...rest,
          choices: response?.choices ?? [],
        };

        for (const choice_chunk of choices_chunk) {
          if (!response.choices[choice_chunk.index]) {
            response.choices[choice_chunk.index] = choice_chunk;
            const message = from_openai_completion(response_chunk, choice_chunk);
            for (const content of message.content) {
              receiver.start_content({ content, message, usage: {} });
            }
            receiver.start_message({ message, usage: {} });
            continue;
          }

          const { delta: delta_chunk, ...rest } = choice_chunk;
          const choice = (response.choices[choice_chunk.index] = {
            ...response.choices[choice_chunk.index],
            ...rest,
            delta: {
              ...response.choices[choice_chunk.index]?.delta,
            },
          });

          if (delta_chunk.role) {
            choice.delta.role = delta_chunk.role;
          }
          if (delta_chunk.refusal) {
            if (!choice.delta.refusal) {
              choice.delta.refusal = "";
            }
            choice.delta.refusal += delta_chunk.refusal;
          }
          const reasoning_delta = get_openai_reasoning_delta(delta_chunk);
          if (reasoning_delta) {
            const choice_delta = choice.delta as OpenAIReasoningDelta;
            const existing = choice_delta[reasoning_delta.key];
            if (!existing) {
              choice_delta[reasoning_delta.key] = reasoning_delta.thought;
              receiver.start_content({
                content: from_openai_thinking(choice_delta) as AssistantContent,
                message: from_openai_completion(response_chunk, choice),
                usage: response?.usage ? from_openai_usage(response.usage) : {},
              });
              receiver.update_message({
                message: from_openai_completion(response_chunk, choice),
                usage: response?.usage ? from_openai_usage(response.usage) : {},
              });
            } else {
              choice_delta[reasoning_delta.key] = existing + reasoning_delta.thought;
              receiver.update_content({
                content: from_openai_thinking(choice_delta) as AssistantContent,
                message: from_openai_completion(response_chunk, choice),
                usage: response?.usage ? from_openai_usage(response.usage) : {},
              });
            }
          }
          if (delta_chunk.content) {
            if (!choice.delta.content) {
              choice.delta.content = delta_chunk.content;
              receiver.start_content({
                content: from_openai_content(choice.delta) as AssistantContent,
                message: from_openai_completion(response_chunk, choice),
                usage: response?.usage ? from_openai_usage(response.usage) : {},
              });
              receiver.update_message({
                message: from_openai_completion(response_chunk, choice),
                usage: response?.usage ? from_openai_usage(response.usage) : {},
              });
            } else {
              choice.delta.content += delta_chunk.content;
              receiver.update_content({
                content: from_openai_content(choice.delta) as AssistantContent,
                message: from_openai_completion(response_chunk, choice),
                usage: response?.usage ? from_openai_usage(response.usage) : {},
              });
            }
          }
          if (delta_chunk.tool_calls) {
            if (!choice.delta.tool_calls) {
              choice.delta.tool_calls = [];
            }
            for (const tool_call_chunk of delta_chunk.tool_calls) {
              if (!choice.delta.tool_calls[tool_call_chunk.index]) {
                choice.delta.tool_calls[tool_call_chunk.index] = tool_call_chunk;
                receiver.start_content({
                  content: from_openai_tool_call(tool_call_chunk),
                  message: from_openai_completion(response_chunk, choice),
                  usage: response?.usage ? from_openai_usage(response.usage) : {},
                });
                receiver.update_message({
                  message: from_openai_completion(response_chunk, choice),
                  usage: response?.usage ? from_openai_usage(response.usage) : {},
                });
              } else {
                const tool_call = choice.delta.tool_calls[tool_call_chunk.index];

                if (tool_call_chunk.id) {
                  tool_call.id = tool_call_chunk.id;
                }
                if (tool_call_chunk.type) {
                  tool_call.type = tool_call_chunk.type;
                }
                if (tool_call_chunk.function) {
                  if (!tool_call.function) {
                    tool_call.function = tool_call_chunk.function;
                  } else {
                    if (tool_call_chunk.function.name) {
                      tool_call.function.name = tool_call_chunk.function.name;
                    }
                    if (tool_call_chunk.function.arguments) {
                      if (!tool_call.function.arguments) {
                        tool_call.function.arguments = "";
                      }
                      tool_call.function.arguments += tool_call_chunk.function.arguments;
                    }
                  }
                }
                receiver.update_content({
                  content: from_openai_tool_call(tool_call),
                  message: from_openai_completion(response_chunk, choice),
                  usage: response?.usage ? from_openai_usage(response.usage) : {},
                });
                receiver.update_message({
                  message: from_openai_completion(response_chunk, choice),
                  usage: response?.usage ? from_openai_usage(response.usage) : {},
                });
              }
            }
          }
        }
      }
      if (!response || !response.choices?.[0]) {
        throw new Error("no data");
      }
      receiver.response_raw({ ...response });

      const message = from_openai_completion(response, response.choices[0]);
      const usage = response?.usage ? from_openai_usage(response.usage) : {};
      for (const content of message.content) {
        receiver.complete_content({ content, message, usage });
      }
      receiver.complete_message({ message, usage, ...map_stop_reason(response) });
    } catch (error) {
      receiver.error(error);
    }
  }
}

function get_system_context(
  model: string,
  system: string | undefined,
  systemRole: OpenAIProviderConfig["systemRole"] = "auto",
): OpenAI.ChatCompletionMessageParam[] {
  if (!system) {
    return [];
  }
  const role = resolve_system_role(model, systemRole);
  if (role === "developer") {
    return [
      {
        role: "developer",
        content: system,
      } as OpenAI.ChatCompletionDeveloperMessageParam,
    ];
  }
  return [
    {
      role: "system",
      content: system,
    } as OpenAI.ChatCompletionSystemMessageParam,
  ];
}

function resolve_system_role(
  model: string,
  systemRole: OpenAIProviderConfig["systemRole"],
): "system" | "developer" {
  if (systemRole === "system" || systemRole === "developer") {
    return systemRole;
  }
  if (model.startsWith("gpt")) {
    return "system";
  }
  if (is_openai_reasoning_model(model)) {
    return "developer";
  }
  return "system";
}

function resolve_strict_tools(
  model: string,
  strictTools: OpenAIProviderConfig["strictTools"],
): boolean {
  if (strictTools === "never") {
    return false;
  }
  return model.startsWith("gpt") || is_openai_reasoning_model(model);
}

// Matches OpenAI's o-series reasoning models: o1, o3, o4-mini, etc.
// Used by both system-role and strict-tool defaults to decide whether the
// model is from the OpenAI o-series family (which uses `developer` and
// supports `strict`) vs. a non-OpenAI-compatible provider.
function is_openai_reasoning_model(model: string): boolean {
  return /^o\d/.test(model);
}

function to_openai_tool(tool: ToolDefinition, strict: boolean): OpenAI.Chat.ChatCompletionTool {
  function map_parameter_type(
    parameter: Prettify<ParameterType & { description?: string }>,
  ): OpenAI.FunctionParameters {
    switch (parameter.type) {
      case "object":
        return {
          type: parameter.required ? parameter.type : [parameter.type, "null"],
          description: parameter.description,
          properties: Object.fromEntries(
            Object.entries(parameter.properties).map(([k, v]) => [k, map_parameter_type(v)]),
          ),
          additionalProperties: false,
          required: Object.entries(parameter.properties).map(([k]) => k),
        };
      case "array":
        return {
          type: parameter.required ? parameter.type : [parameter.type, "null"],
          description: parameter.description,
          items: map_parameter_type(parameter.items),
        };
      default:
        return {
          type: parameter.required ? parameter.type : [parameter.type, "null"],
          description:
            parameter.default !== undefined
              ? parameter.description
                ? `${parameter.description} (default: ${parameter.default})`
                : `default: ${parameter.default}`
              : parameter.description,
          enum: "enum" in parameter ? parameter.enum : undefined,
        };
    }
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: map_parameter_type({
        type: "object",
        required: true,
        properties: Object.fromEntries(
          tool.parameters.map(({ name, ...parameter }) => [name, parameter]),
        ),
      }),
      ...(strict ? { strict: true } : {}),
    },
  };
}

function from_openai_completion(
  completion: OpenAI.Chat.Completions.ChatCompletionChunk,
  choice: OpenAI.Chat.Completions.ChatCompletionChunk.Choice,
) {
  let contents: Content[] = [];
  const thinking = from_openai_thinking(choice.delta);
  if (thinking) {
    contents = [...contents, thinking];
  }
  const delta_record = choice.delta as Record<string, unknown>;
  for (const key of Object.keys(choice.delta)) {
    if (key === "role") {
      continue;
    }
    if (is_openai_reasoning_delta_key(key)) {
      continue;
    }
    if (key === "content") {
      if (choice.delta.content) {
        contents = [...contents, from_openai_content(choice.delta)];
      }
      continue;
    }
    if (key === "refusal") {
      if (choice.delta.refusal) {
        contents = [...contents, from_openai_refusal(choice.delta)];
      }
      continue;
    }
    if (key === "tool_calls") {
      if (choice.delta.tool_calls) {
        contents = [...contents, ...choice.delta.tool_calls.map((t) => from_openai_tool_call(t))];
      }
      continue;
    }
    if (delta_record[key] !== undefined && delta_record[key] !== null) {
      const data = delta_record[key];
      contents = [
        ...contents,
        {
          type: "raw",
          model_kind: "openai",
          data: JSON.stringify({ [key]: data }),
        },
      ];
    }
  }
  return {
    id: completion.id,
    timestamp: completion.created,
    role: map_role(choice),
    content: contents,
  } as AssistantMessage;
}

function get_openai_reasoning_delta(delta: OpenAICompletionDelta) {
  const record = delta as Partial<Record<OpenAIReasoningDeltaKey, unknown>>;
  for (const key of OPENAI_REASONING_DELTA_KEYS) {
    const thought = record[key];
    if (typeof thought === "string" && thought.length > 0) {
      return { key, thought };
    }
  }
  return undefined;
}

function from_openai_thinking(content: OpenAICompletionDelta) {
  const reasoning = get_openai_reasoning_delta(content);
  if (!reasoning) {
    return undefined;
  }
  const extended = get_openai_delta_extended(content);
  return {
    type: "thinking",
    thought: reasoning.thought,
    extended: {
      ...extended,
      openai_reasoning_field: reasoning.key,
    },
  } as Content;
}

function is_openai_reasoning_delta_key(key: string): key is OpenAIReasoningDeltaKey {
  return OPENAI_REASONING_DELTA_KEYS.includes(key as OpenAIReasoningDeltaKey);
}

function from_openai_refusal(content: OpenAICompletionDelta) {
  return {
    type: "text",
    text: content.refusal,
    extended: {
      ...get_openai_delta_extended(content),
      openai_refusal: true,
    },
  } as Content;
}

function from_openai_content(content: OpenAICompletionDelta) {
  return {
    type: "text",
    text: content.content,
    extended: get_openai_delta_extended(content),
  } as Content;
}

function get_openai_delta_extended(content: OpenAICompletionDelta) {
  const extended = { ...(content as Record<string, unknown>) };
  delete extended.content;
  delete extended.tool_calls;
  delete extended.function_call;
  delete extended.refusal;
  delete extended.role;
  for (const key of OPENAI_REASONING_DELTA_KEYS) {
    delete extended[key];
  }
  return extended;
}

function from_openai_tool_call(
  tool_call: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall,
) {
  const { id: tool_request_id, function: fn, type: _, index: __, ...extended } = tool_call;
  let params: unknown;
  try {
    params = JSON.parse(fn?.arguments ?? "{}");
  } catch {
    params = fn?.arguments;
  }
  return {
    tool_request_id,
    type: "tool",
    tool: fn?.name,
    params,
    extended,
  } as ToolContent;
}

function to_openai_messages(message: Message) {
  if (message.role === "assistant") {
    return [to_openai_assistant_message(message)];
  }
  // Partition content so tool_result blocks come before non-tool_result blocks.
  // OpenAI requires all tool-role messages immediately after the assistant message
  // containing the corresponding tool_calls; interleaving user messages between
  // tool messages causes a validation error.
  const tool_result_content = message.content.filter((c) => c.type === "tool_result");
  const other_content = message.content.filter((c) => c.type !== "tool_result");
  const ordered_content = [...tool_result_content, ...other_content];

  const results: OpenAI.ChatCompletionMessageParam[] = [];
  let result: OpenAI.ChatCompletionMessageParam | undefined;
  for (const content of ordered_content) {
    if (content.type === "text") {
      if (!result) {
        result = {
          role: "user",
          content: content.text,
        };
      } else if (result.role === "tool") {
        results.push(result);
        result = {
          role: "user",
          content: content.text,
        };
      } else {
        if (typeof result.content === "string") {
          result.content = [
            {
              type: "text",
              text: result.content,
            },
          ];
        }
        if (!result.content) {
          result.content = [
            {
              type: "text",
              text: content.text,
            },
          ];
        } else {
          result.content.push({
            type: "text",
            text: content.text,
          });
        }
      }
    } else if (content.type === "tool_result") {
      if (!result) {
        result = {
          role: "tool",
          tool_call_id: content.tool_request_id,
          content: JSON.stringify(content.result),
        };
      } else if (result.role !== "tool" || result.tool_call_id !== content.tool_request_id) {
        results.push(result);
        result = {
          role: "tool",
          tool_call_id: content.tool_request_id,
          content: JSON.stringify(content.result),
        };
      } else {
        if (typeof result.content === "string") {
          result.content = [
            {
              type: "text",
              text: result.content,
            },
          ];
        }
        result.content.push({
          type: "text",
          text: JSON.stringify(content.result),
        });
      }
    } else if (content.type === "raw") {
      result = {
        ...(result ?? {}),
        ...JSON.parse(content.data),
      };
    }
  }
  if (result) {
    results.push(result);
  }
  return results;
}

function to_openai_assistant_message(message: AssistantMessage) {
  let result: OpenAI.ChatCompletionAssistantMessageParam = {
    role: "assistant",
  };
  for (const content of message.content) {
    switch (content.type) {
      case "text":
        if (content.extended && content.extended.openai_refusal === true) {
          result.refusal = content.text;
        } else {
          if (typeof result.content === "string") {
            result.content = [
              {
                type: "text",
                text: result.content,
              },
            ];
          }
          if (!result.content) {
            result.content = content.text;
          } else {
            result.content.push({
              type: "text",
              text: content.text,
            });
          }
        }
        break;
      case "tool":
        if (!result.tool_calls) {
          result.tool_calls = [];
        }
        result.tool_calls.push({
          id: content.tool_request_id,
          type: "function",
          function: {
            name: content.tool,
            arguments: JSON.stringify(content.params),
          },
        });
        break;
      case "raw":
        if (content.model_kind !== "openai") {
          if (typeof result.content === "string") {
            result.content = [
              {
                type: "text",
                text: result.content,
              },
            ];
          }
          if (!result.content) {
            result.content = content.data;
          } else {
            result.content.push({
              type: "text",
              text: content.data,
            });
          }
          break;
        }
        result = {
          ...result,
          ...JSON.parse(content.data),
        };
        break;
      case "thinking":
        if (typeof result.content === "string") {
          result.content = [
            {
              type: "text",
              text: result.content,
            },
          ];
        }
        if (!result.content) {
          result.content = content.thought;
        } else {
          result.content.push({
            type: "text",
            text: content.thought,
          });
        }
        break;
      default:
        throw new Error("unexpected content type");
    }
  }
  return result;
}

function from_openai_usage(usage: OpenAI.CompletionUsage | null | undefined) {
  return {
    input_tokens: usage?.prompt_tokens,
    output_tokens: usage?.completion_tokens,
  } as Usage;
}

function map_stop_reason(
  completion: OpenAI.ChatCompletionChunk,
): Pick<CompletionResponseData, "stop_reason" | "stop_details"> {
  for (const choice of completion.choices) {
    switch (choice.finish_reason) {
      case "content_filter":
        return {
          stop_reason: "error",
          stop_details: choice.finish_reason,
        };
      case "function_call":
        return {
          stop_reason: "tool_use",
        };
      case "length":
        return {
          stop_reason: "max_tokens",
        };
      case "stop":
        return {
          stop_reason: "end_turn",
        };
      case "tool_calls":
        return {
          stop_reason: "tool_use",
        };
      default:
        return {
          stop_reason: "other",
          stop_details: `${choice.finish_reason}`,
        };
    }
  }
  return {
    stop_reason: "other",
  };
}

function map_role(choice: OpenAI.Chat.Completions.ChatCompletionChunk.Choice) {
  switch (choice.delta.role) {
    case "user":
    case "developer":
    case "system":
      return "user";
    case "assistant":
    case "tool":
      return "assistant";
    default:
      throw new Error("invalid role");
  }
}
