import crypto from "node:crypto";

import * as gemini from "@google/genai";

import type {
  AssistantContent,
  AssistantMessage,
  CancellationToken,
  CompletionResponseData,
  Content,
  EnumParameterType,
  Message,
  ModelProvider,
  ModelRequest,
  ParameterType,
  ProviderContextTransformer,
  StreamReceiver,
  ToolDefinition,
} from "@simulacra-ai/core";
import { deep_merge, peek_generator, undefined_if_empty } from "@simulacra-ai/core";
import { GoogleToolCodeContextTransformer } from "./google-tool-code-context-transformer.ts";

/**
 * Configuration options for the Google Gemini provider.
 */
export interface GoogleProviderConfig extends Record<string, unknown> {
  /** The model identifier to use (e.g., "gemini-2.0-flash-exp"). */
  model: string;
  /** The maximum number of tokens to generate in the response. */
  max_tokens?: number;
  /** Configuration for extended thinking mode. */
  thinking?: {
    /** Whether to enable extended thinking. */
    enable: boolean;
    /** The token budget allocated for thinking. */
    budget_tokens?: number;
  };
}

/**
 * Model provider implementation for Google's Gemini models.
 *
 * This provider wraps the Google Generative AI SDK to provide streaming completions
 * with support for tool use, extended thinking, and multimodal content. It handles
 * message formatting, content streaming, and usage tracking according to the
 * ModelProvider interface.
 */
export class GoogleProvider implements ModelProvider {
  readonly #sdk: gemini.GoogleGenAI;
  readonly #config: GoogleProviderConfig;

  readonly context_transformers: ProviderContextTransformer[];

  /**
   * Creates a new Google Gemini provider instance.
   *
   * @param sdk - The initialized Google Generative AI SDK client.
   * @param config - Configuration options for the provider.
   * @param context_transformers - Provider-level context transformers. Defaults to GoogleToolCodeContextTransformer.
   */
  constructor(
    sdk: gemini.GoogleGenAI,
    config: GoogleProviderConfig,
    context_transformers: ProviderContextTransformer[] = [new GoogleToolCodeContextTransformer()],
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
    const { model, max_tokens, thinking, ...api_extras } = this.#config;
    const params: gemini.GenerateContentParameters = {
      model,

      config: {
        ...api_extras,
        systemInstruction: request.system,
        maxOutputTokens: max_tokens,
        thinkingConfig: {
          includeThoughts: thinking?.enable,
          thinkingBudget: thinking?.budget_tokens,
        },
        ...(request.tools.length > 0
          ? {
              tools: [
                {
                  functionDeclarations: request.tools.map((t) => to_gemini_tool(t)),
                },
              ],
            }
          : {}),
      },
      contents: request.messages.map((m) => to_gemini_content(m)),
    };
    receiver.before_request({ params });
    receiver.request_raw(params);

    const response = await this.#sdk.models.generateContentStream(params);
    const { peeked_value: _peeked_value, generator } = (await peek_generator(response)) as {
      peeked_value: gemini.GenerateContentResponse;
      generator: AsyncGenerator<gemini.GenerateContentResponse>;
    };

    // Intentionally not awaited. Streaming is event-driven through the receiver.
    // The policy wraps only connection establishment; chunk processing flows
    // asynchronously via StreamListener events back to the conversation.
    this.#stream_response(generator, receiver, cancellation);
  }

  /**
   * Creates a clone of this provider with the same configuration.
   *
   * @returns A new provider instance with identical configuration.
   */
  clone(): ModelProvider {
    return new GoogleProvider(this.#sdk, this.#config, this.context_transformers);
  }

  async #stream_response(
    stream: AsyncGenerator<gemini.GenerateContentResponse>,
    receiver: StreamReceiver,
    cancellation: CancellationToken,
  ) {
    try {
      let response: Partial<gemini.GenerateContentResponse> | undefined;
      const completed_parts = new Set<number>();
      for await (const response_chunk of stream) {
        if (cancellation.is_cancellation_requested) {
          receiver.cancel();
          return;
        }
        receiver.stream_raw(response_chunk);

        const { candidates: candidates_chunk, ...rest } = response_chunk;
        response = {
          ...response,
          ...rest,
          candidates: response?.candidates ?? [],
        };
        const candidates = response.candidates as gemini.Candidate[];

        for (const candidate_chunk of candidates_chunk ?? []) {
          if (!candidates[candidate_chunk.index ?? 0]) {
            candidates[candidate_chunk.index ?? 0] = candidate_chunk;
            const message = from_gemini_content(candidate_chunk.content) as AssistantMessage;
            const usage = from_gemini_usage(response.usageMetadata);
            for (const content of message.content) {
              receiver.start_content({ content, message, usage });
            }
            receiver.start_message({ message, usage });
            continue;
          }
          const { content: content_chunk, ...rest } = candidate_chunk;
          const candidate = (candidates[candidate_chunk.index ?? 0] = {
            ...candidates[candidate_chunk.index ?? 0],
            ...rest,
            content: {
              ...candidates[candidate_chunk.index ?? 0]?.content,
              parts: candidates[candidate_chunk.index ?? 0]?.content?.parts ?? [],
            },
          });

          for (const part_chunk of content_chunk?.parts ?? []) {
            const [part] = candidate.content.parts.slice(-1);
            if (!part) {
              candidate.content.parts.push(part_chunk);
              receiver.start_content({
                message: from_gemini_content(candidate.content) as AssistantMessage,
                content: from_gemini_part(part_chunk) as AssistantContent,
                usage: from_gemini_usage(response.usageMetadata),
              });
              receiver.update_message({
                message: from_gemini_content(candidate.content) as AssistantMessage,
                usage: from_gemini_usage(response?.usageMetadata),
              });
            } else {
              if (part_chunk.thought && part.thought) {
                part.text = (part.text ?? "") + (part_chunk.text ?? "");
              } else if (!part_chunk.thought && !part.thought && part_chunk.text && part.text) {
                part.text = (part.text ?? "") + (part_chunk.text ?? "");
              } else if (part_chunk.functionCall && part.functionCall) {
                part.functionCall = deep_merge(part.functionCall, part_chunk.functionCall);
              } else if (part_chunk.executableCode && part.executableCode) {
                if (part_chunk.executableCode.code && part.executableCode.code) {
                  part.executableCode.code += part_chunk.executableCode.code;
                  delete part_chunk.executableCode.code;
                }
                part.executableCode = deep_merge(part.executableCode, part_chunk.executableCode);
              } else if (part_chunk.videoMetadata && part.videoMetadata) {
                part.videoMetadata = deep_merge(part.videoMetadata, part_chunk.videoMetadata);
              } else if (part_chunk.fileData && part.fileData) {
                part.fileData = deep_merge(part.fileData, part_chunk.fileData);
              } else if (part_chunk.inlineData && part.inlineData) {
                part.inlineData = deep_merge(part.inlineData, part_chunk.inlineData);
              } else {
                receiver.complete_content({
                  message: from_gemini_content(candidate.content) as AssistantMessage,
                  content: from_gemini_part(part) as AssistantContent,
                  usage: from_gemini_usage(response.usageMetadata),
                });
                completed_parts.add(candidate.content.parts.length - 1);
                candidate.content.parts.push(part_chunk);
                receiver.start_content({
                  message: from_gemini_content(candidate.content) as AssistantMessage,
                  content: from_gemini_part(part_chunk) as AssistantContent,
                  usage: from_gemini_usage(response.usageMetadata),
                });
                receiver.update_message({
                  message: from_gemini_content(candidate.content) as AssistantMessage,
                  usage: from_gemini_usage(response?.usageMetadata),
                });
                continue;
              }
              receiver.update_content({
                message: from_gemini_content(candidate.content) as AssistantMessage,
                content: from_gemini_part(part) as AssistantContent,
                usage: from_gemini_usage(response.usageMetadata),
              });
            }
          }
        }
      }
      if (!response || !response.candidates?.[0]) {
        throw new Error("no data", { cause: JSON.stringify(response?.promptFeedback ?? response) });
      }
      receiver.response_raw({ ...response });

      const message = from_gemini_content(response.candidates[0].content) as AssistantMessage;
      const usage = from_gemini_usage(response.usageMetadata);
      for (let i = 0; i < message.content.length; i++) {
        if (!completed_parts.has(i)) {
          receiver.complete_content({ content: message.content[i], message, usage });
        }
      }
      receiver.complete_message({ message, usage, ...map_stop_reason(response) });
    } catch (error) {
      receiver.error(error);
    }
  }
}

function to_gemini_tool(tool: ToolDefinition): gemini.FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: gemini.Type.OBJECT,
      properties: undefined_if_empty(
        Object.fromEntries(
          tool.parameters.map((p) => [p.name, to_gemini_tool_schema(p, p.description)]),
        ),
      ),
      required: undefined_if_empty(tool.parameters.filter((p) => p.required).map((p) => p.name)),
    },
  };
}

function from_gemini_content(content?: gemini.Content) {
  if (!content) {
    return;
  }
  return {
    role: content.role === "model" ? "assistant" : "user",
    content: content.parts?.map((p: gemini.Part) => from_gemini_part(p)).filter(Boolean),
  };
}

function from_gemini_part(part: gemini.Part) {
  if (!part) {
    return;
  }
  if (part.thought) {
    return {
      type: "thinking",
      thought: part.text ?? "",
    };
  }
  if ("text" in part) {
    return {
      type: "text",
      text: part.text ?? "",
    };
  }
  if (part.functionCall) {
    return {
      type: "tool",
      tool_request_id: part.functionCall.id ?? crypto.randomUUID(),
      tool: part.functionCall.name ?? "",
      params: part.functionCall.args ?? {},
    };
  }
  if (part.functionResponse) {
    return {
      type: "tool_result",
      tool_request_id: part.functionResponse.id ?? "",
      tool: part.functionResponse.name ?? "",
      result: part.functionResponse.response ?? {},
    };
  }
  return {
    type: "raw",
    model_kind: "google",
    data: JSON.stringify(part),
  };
}

function to_gemini_content(message: Message): gemini.Content {
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: message.content.map((c) => to_gemini_part(c)),
  };
}

function to_gemini_part(content: Readonly<Content>) {
  switch (content.type) {
    case "text":
      return {
        text: content.text,
      };
    case "tool":
      return {
        functionCall: {
          id: content.tool_request_id,
          name: content.tool,
          args: content.params,
        },
      };
    case "raw":
      if (content.model_kind === "google") {
        try {
          return {
            ...JSON.parse(content.data),
          };
        } catch {
          return {
            text: content.data,
          };
        }
      }
      return {
        text: content.data,
      };
    case "tool_result":
      return {
        functionResponse: {
          id: content.tool_request_id,
          name: content.tool,
          response: content.result,
        },
      };
    case "thinking":
      return {
        thought: true,
        text: content.thought,
      };
    default:
      throw new Error("unexpected content type");
  }
}

function to_gemini_tool_schema(parameter_type: ParameterType, description?: string): gemini.Schema {
  switch (parameter_type.type) {
    case "string":
      return {
        type: gemini.Type.STRING,
        description,
        enum: (parameter_type as EnumParameterType).enum,
        default: !parameter_type.required ? parameter_type.default : undefined,
      };
    case "number":
      return {
        type: gemini.Type.NUMBER,
        description,
        default: !parameter_type.required ? parameter_type.default : undefined,
      };
    case "boolean":
      return {
        type: gemini.Type.BOOLEAN,
        description,
        default: !parameter_type.required ? parameter_type.default : undefined,
      };
    case "object":
      return {
        type: gemini.Type.OBJECT,
        description,
        properties: Object.fromEntries(
          Object.entries(parameter_type.properties).map(([name, p]) => [
            name,
            to_gemini_tool_schema(p, p.description),
          ]),
        ),
        required: undefined_if_empty(
          Object.entries(parameter_type.properties)
            .filter(([, p]) => p.required)
            .map(([name]) => name),
        ),
      };
    case "array":
      return {
        type: gemini.Type.ARRAY,
        description,
        items: to_gemini_tool_schema(parameter_type.items, parameter_type.items.description),
      };
  }
}

function from_gemini_usage(usage: gemini.GenerateContentResponseUsageMetadata | undefined) {
  return {
    cache_read_input_tokens: usage?.cachedContentTokenCount,
    input_tokens: usage?.promptTokenCount,
    output_tokens: usage?.candidatesTokenCount,
  };
}

function map_stop_reason(
  response: Partial<gemini.GenerateContentResponse>,
): Pick<CompletionResponseData, "stop_reason" | "stop_details"> {
  for (const { finishReason, finishMessage } of response?.candidates ?? []) {
    switch (finishReason) {
      case gemini.FinishReason.STOP:
        if (response.candidates?.[0].content?.parts?.some((p: gemini.Part) => !!p.functionCall)) {
          return {
            stop_reason: "tool_use",
            stop_details: finishMessage,
          };
        } else {
          return {
            stop_reason: "end_turn",
            stop_details: finishMessage,
          };
        }
      case gemini.FinishReason.MAX_TOKENS:
        return {
          stop_reason: "max_tokens",
          stop_details: finishMessage,
        };
      case gemini.FinishReason.MALFORMED_FUNCTION_CALL:
        return {
          stop_reason: "error",
          stop_details: finishMessage,
        };
      case gemini.FinishReason.SAFETY:
      case gemini.FinishReason.RECITATION:
      case gemini.FinishReason.LANGUAGE:
      case gemini.FinishReason.BLOCKLIST:
      case gemini.FinishReason.PROHIBITED_CONTENT:
      case gemini.FinishReason.SPII:
      case gemini.FinishReason.IMAGE_SAFETY:
        return {
          stop_reason: "error",
          stop_details: finishMessage,
        };
      case gemini.FinishReason.FINISH_REASON_UNSPECIFIED:
    }
  }
  return {
    stop_reason: "other",
  };
}
