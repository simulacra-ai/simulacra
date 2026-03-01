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

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

/**
 * Configuration options for the FireworksAI provider.
 */
export type FireworksAIProviderConfig = Record<string, unknown> & {
  /** The model identifier to use (e.g., "accounts/fireworks/models/llama-v3p1-8b-instruct"). */
  model: string;
  /** The maximum number of tokens to generate in the response. */
  max_tokens?: number;
};

/**
 * Creates an OpenAI SDK client configured to target the FireworksAI API.
 *
 * @param apiKey - Your Fireworks AI API key.
 * @returns A configured OpenAI client instance pointed at the Fireworks endpoint.
 */
export function createFireworksAIClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: FIREWORKS_BASE_URL,
  });
}

/**
 * Model provider implementation for FireworksAI's OpenAI-compatible chat completion API.
 *
 * FireworksAI exposes an OpenAI-compatible endpoint, so this provider uses the
 * OpenAI SDK under the hood (pointed at the Fireworks base URL via `createFireworksAIClient`).
 * It handles message formatting, content streaming, and usage tracking according to
 * the ModelProvider interface. System prompts always use the standard `system` role.
 */
export class FireworksAIProvider implements ModelProvider {
  readonly #sdk: OpenAI;
  readonly #config: FireworksAIProviderConfig;
  readonly context_transformers: ProviderContextTransformer[];

  /**
   * Creates a new FireworksAI provider instance.
   *
   * @param sdk - An OpenAI SDK client configured for the Fireworks endpoint (see `createFireworksAIClient`).
   * @param config - Configuration options for the provider.
   * @param context_transformers - Provider-level context transformers.
   */
  constructor(
    sdk: OpenAI,
    config: FireworksAIProviderConfig,
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
    const { model, max_tokens, ...api_extras } = this.#config;
    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      ...api_extras,
      model,
      stream: true,
      max_tokens,
      ...(request.tools.length > 0
        ? {
            tool_choice: "auto",
            tools: request.tools.map((t) => to_fireworksai_tool(t)),
          }
        : {}),
      messages: [
        ...get_system_message(request.system),
        ...request.messages.flatMap((m) => to_fireworksai_messages(m)),
      ],
      stream_options: {
        include_usage: true,
      },
    };

    receiver.before_request({ params });
    receiver.request_raw(params);

    const stream = await this.#sdk.chat.completions.create(params);

    // Intentionally not awaited. Streaming is event-driven through the receiver.
    this.#stream_response(stream, receiver, cancellation);
  }

  /**
   * Creates a clone of this provider with the same configuration.
   *
   * @returns A new provider instance with identical configuration.
   */
  clone(): ModelProvider {
    return new FireworksAIProvider(this.#sdk, this.#config, this.context_transformers);
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
            const message = from_fireworksai_completion(response_chunk, choice_chunk);
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
          if (delta_chunk.content) {
            if (!choice.delta.content) {
              choice.delta.content = delta_chunk.content;
              receiver.start_content({
                content: from_fireworksai_content(choice.delta) as AssistantContent,
                message: from_fireworksai_completion(response_chunk, choice),
                usage: response?.usage ? from_fireworksai_usage(response.usage) : {},
              });
              receiver.update_message({
                message: from_fireworksai_completion(response_chunk, choice),
                usage: response?.usage ? from_fireworksai_usage(response.usage) : {},
              });
            } else {
              choice.delta.content += delta_chunk.content;
              receiver.update_content({
                content: from_fireworksai_content(choice.delta) as AssistantContent,
                message: from_fireworksai_completion(response_chunk, choice),
                usage: response?.usage ? from_fireworksai_usage(response.usage) : {},
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
                  content: from_fireworksai_tool_call(tool_call_chunk),
                  message: from_fireworksai_completion(response_chunk, choice),
                  usage: response?.usage ? from_fireworksai_usage(response.usage) : {},
                });
                receiver.update_message({
                  message: from_fireworksai_completion(response_chunk, choice),
                  usage: response?.usage ? from_fireworksai_usage(response.usage) : {},
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
                  content: from_fireworksai_tool_call(tool_call),
                  message: from_fireworksai_completion(response_chunk, choice),
                  usage: response?.usage ? from_fireworksai_usage(response.usage) : {},
                });
                receiver.update_message({
                  message: from_fireworksai_completion(response_chunk, choice),
                  usage: response?.usage ? from_fireworksai_usage(response.usage) : {},
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

      const message = from_fireworksai_completion(response, response.choices[0]);
      const usage = response?.usage ? from_fireworksai_usage(response.usage) : {};
      for (const content of message.content) {
        receiver.complete_content({ content, message, usage });
      }
      receiver.complete_message({ message, usage, ...map_stop_reason(response) });
    } catch (error) {
      receiver.error(error);
    }
  }
}

function get_system_message(system?: string): OpenAI.ChatCompletionMessageParam[] {
  if (!system) {
    return [];
  }
  return [
    {
      role: "system",
      content: system,
    } as OpenAI.ChatCompletionSystemMessageParam,
  ];
}

function to_fireworksai_tool(tool: ToolDefinition): OpenAI.Chat.ChatCompletionTool {
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
    },
  };
}

function from_fireworksai_completion(
  completion: OpenAI.Chat.Completions.ChatCompletionChunk,
  choice: OpenAI.Chat.Completions.ChatCompletionChunk.Choice,
) {
  let contents: Content[] = [];
  for (const k in choice.delta) {
    const key = k as keyof typeof choice.delta;
    if (key === "role") {
      continue;
    }
    if (key === "content" && choice.delta.content) {
      contents = [...contents, from_fireworksai_content(choice.delta)];
    } else if (key === "refusal" && choice.delta.refusal) {
      contents = [...contents, from_fireworksai_refusal(choice.delta)];
    } else if (key === "tool_calls" && choice.delta.tool_calls) {
      contents = [
        ...contents,
        ...choice.delta.tool_calls.map((t) => from_fireworksai_tool_call(t)),
      ];
    } else if (choice.delta[key] !== undefined && choice.delta[key] !== null) {
      const { [key]: data } = choice.delta;
      contents = [
        ...contents,
        {
          type: "raw",
          model_kind: "fireworksai",
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

function from_fireworksai_refusal(
  content: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta,
) {
  const { refusal, tool_calls: _, function_call: __, content: ___, role: ____, ...rest } = content;
  return {
    type: "text",
    text: refusal,
    extended: {
      ...rest,
      fireworksai_refusal: true,
    },
  } as Content;
}

function from_fireworksai_content(
  content: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta,
) {
  const {
    content: c,
    tool_calls: _,
    function_call: __,
    refusal: ___,
    role: ____,
    ...rest
  } = content;
  return {
    type: "text",
    text: c,
    extended: rest,
  } as Content;
}

function from_fireworksai_tool_call(
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

function to_fireworksai_messages(message: Message) {
  if (message.role === "assistant") {
    return [to_fireworksai_assistant_message(message)];
  }
  // Partition content so tool_result blocks come before non-tool_result blocks.
  // FireworksAI requires all tool-role messages immediately after the assistant message
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

function to_fireworksai_assistant_message(message: AssistantMessage) {
  let result: OpenAI.ChatCompletionAssistantMessageParam = {
    role: "assistant",
  };
  for (const content of message.content) {
    switch (content.type) {
      case "text":
        if (
          content.extended &&
          (content.extended.fireworksai_refusal === true ||
            content.extended.openai_refusal === true)
        ) {
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
        // Handle raw content from fireworksai or openai providers (format-compatible)
        if (content.model_kind !== "fireworksai" && content.model_kind !== "openai") {
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
  // Some OpenAI-compatible backends (e.g. Mixtral via Fireworks Jinja templates) require
  // the `content` key to be present on assistant messages even when it is null. The OpenAI
  // API accepts a missing key, but other backends reject it with a 400 template error.
  if (result.tool_calls && result.content === undefined) {
    result.content = null;
  }
  return result;
}

function from_fireworksai_usage(usage: OpenAI.CompletionUsage | null | undefined) {
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
