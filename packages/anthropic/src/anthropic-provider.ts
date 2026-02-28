import Anthropic from "@anthropic-ai/sdk";

import type {
  AssistantContent,
  AssistantMessage,
  CancellationToken,
  Content,
  Message,
  ModelProvider,
  ModelRequest,
  ParameterType,
  ProviderContextTransformer,
  StreamReceiver,
  ToolDefinition,
} from "@simulacra-ai/core";

/**
 * Configuration options for the Anthropic provider.
 */
export interface AnthropicProviderConfig extends Record<string, unknown> {
  /** The model identifier to use. */
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
  /** Configuration for prompt caching. Enabled by default when omitted. Cache writes cost more per token than standard requests, but cache reads on subsequent turns cost less. */
  prompt_caching?: {
    /** Whether to cache the system prompt. */
    system_prompt?: boolean;
    /** Whether to cache the tool definitions. */
    toolkit?: boolean;
  };
  /** Custom request options passed to every SDK call. Accepts a static object or a function that returns (or resolves to) request options. Useful for injecting custom authentication headers or other per-request configuration. */
  request_options?: Anthropic.RequestOptions | (() => Anthropic.RequestOptions | Promise<Anthropic.RequestOptions>);
}

/**
 * Model provider implementation for Anthropic's Claude models.
 *
 * This provider wraps the Anthropic SDK to provide streaming completions with support
 * for tool use, extended thinking, and prompt caching. It handles message formatting,
 * content streaming, and usage tracking according to the ModelProvider interface.
 */
export class AnthropicProvider implements ModelProvider {
  readonly #sdk: Anthropic;
  readonly #config: AnthropicProviderConfig;
  readonly context_transformers: ProviderContextTransformer[];

  /**
   * Creates a new Anthropic provider instance.
   *
   * @param sdk - The initialized Anthropic SDK client.
   * @param config - Configuration options for the provider.
   * @param context_transformers - Provider-level context transformers.
   */
  constructor(
    sdk: Anthropic,
    config: AnthropicProviderConfig,
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
    const {
      model,
      max_tokens,
      thinking,
      prompt_caching,
      request_options,
      ...api_extras
    } = this.#config;
    const cache_system = prompt_caching?.system_prompt !== false;
    const cache_tools = prompt_caching?.toolkit !== false;

    const tools = request.tools.map((t) => to_anthropic_tool(t));

    if (cache_tools && tools.length > 0) {
      const last = tools.length - 1;
      (tools[last] as Anthropic.Messages.Tool).cache_control = { type: "ephemeral" };
    }

    const system: Anthropic.MessageCreateParamsStreaming["system"] =
      cache_system && request.system
        ? [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }]
        : request.system;

    const params: Anthropic.MessageCreateParamsStreaming = {
      ...api_extras,
      model,
      stream: true,
      system,
      max_tokens: max_tokens ?? 8_192,
      thinking:
        thinking?.enable && thinking?.budget_tokens
          ? {
              type: "enabled",
              budget_tokens: thinking.budget_tokens,
            }
          : {
              type: "disabled",
            },
      tools,
      messages: request.messages.map((m) => to_anthropic_message(m)),
    };
    receiver.before_request({ params });
    receiver.request_raw(params);

    const resolved_options = typeof request_options === "function"
      ? await request_options()
      : request_options;

    const response = await this.#sdk.messages.create(
      params,
      resolved_options,
    );

    // Intentionally not awaited. Streaming is event-driven through the receiver.
    // The policy wraps only connection establishment; chunk processing flows
    // asynchronously via StreamListener events back to the conversation.
    this.#stream_response(response, receiver, cancellation);
  }

  /**
   * Creates a clone of this provider with the same configuration.
   *
   * @returns A new provider instance with identical configuration.
   */
  clone(): ModelProvider {
    return new AnthropicProvider(this.#sdk, this.#config, this.context_transformers);
  }

  async #stream_response(
    stream: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>,
    receiver: StreamReceiver,
    cancellation: CancellationToken,
  ) {
    try {
      let usage: Record<string, number> = {};
      let message: Partial<Anthropic.Message> & { content: Anthropic.ContentBlock[] } = {
        content: [],
      };
      const json: string[] = [];
      for await (const chunk of stream) {
        if (cancellation.is_cancellation_requested) {
          receiver.cancel();
          return;
        }
        receiver.stream_raw(chunk);
        switch (chunk.type) {
          case "message_start": {
            usage = Object.fromEntries(
              Object.entries(chunk.message.usage).filter(([, v]) => typeof v === "number"),
            ) as Record<string, number>;
            message = chunk.message;
            receiver.start_message({
              usage,
              message: from_anthropic_message(message) as AssistantMessage,
            });
            break;
          }
          case "message_delta": {
            usage = {
              ...usage,
              ...Object.fromEntries(
                Object.entries(chunk.usage).filter(([, v]) => typeof v === "number"),
              ),
            };
            message = { ...message, ...chunk.delta };
            receiver.update_message({
              usage,
              message: from_anthropic_message(message) as AssistantMessage,
            });
            break;
          }
          case "message_stop": {
            const raw_stop = message.stop_reason ?? "end_turn";
            const stop_reason = (
              ["tool_use", "stop_sequence", "end_turn", "max_tokens", "error"].includes(raw_stop)
                ? raw_stop
                : "other"
            ) as "tool_use" | "stop_sequence" | "end_turn" | "max_tokens" | "error" | "other";
            receiver.complete_message({
              usage,
              stop_reason,
              message: from_anthropic_message(message) as AssistantMessage,
            });
            break;
          }
          case "content_block_start": {
            message.content[chunk.index] = chunk.content_block;
            receiver.start_content({
              usage,
              message: from_anthropic_message(message) as AssistantMessage,
              content: from_anthropic_content(chunk.content_block) as Partial<AssistantContent>,
            });
            receiver.update_message({
              usage,
              message: from_anthropic_message(message) as AssistantMessage,
            });
            break;
          }
          case "content_block_delta": {
            switch (chunk.delta.type) {
              case "text_delta": {
                const content = message.content[chunk.index] as Anthropic.TextBlock;
                content.text += chunk.delta.text;
                break;
              }
              case "citations_delta": {
                const content = message.content[chunk.index] as Anthropic.TextBlock;
                content.citations = [...(content.citations ?? []), chunk.delta.citation];
                break;
              }
              case "thinking_delta": {
                const content = message.content[chunk.index] as Anthropic.ThinkingBlock;
                content.thinking += chunk.delta.thinking;
                break;
              }
              case "input_json_delta": {
                if (!json[chunk.index]) {
                  json[chunk.index] = "";
                }
                json[chunk.index] += chunk.delta.partial_json;
                break;
              }
              case "signature_delta": {
                const content = message.content[chunk.index] as Anthropic.ThinkingBlock;
                content.signature = (content.signature ?? "") + chunk.delta.signature;
                break;
              }
            }
            receiver.update_content({
              usage,
              message: from_anthropic_message(message) as AssistantMessage,
              content: from_anthropic_content(message.content[chunk.index]) as AssistantContent,
            });
            break;
          }
          case "content_block_stop": {
            const content_block = message.content[chunk.index];
            if (content_block.type === "tool_use" && json[chunk.index]) {
              content_block.input = {
                ...(content_block.input ?? {}),
                ...JSON.parse(json[chunk.index]),
              };
            }
            receiver.complete_content({
              usage,
              message: from_anthropic_message(message) as AssistantMessage,
              content: from_anthropic_content(content_block) as AssistantContent,
            });
            break;
          }
        }
      }
      receiver.response_raw(message);
    } catch (error) {
      receiver.error(error);
    }
  }
}

function parameter_to_json_schema(param: ParameterType): Record<string, unknown> {
  switch (param.type) {
    case "object": {
      const properties: Record<string, Record<string, unknown>> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(param.properties)) {
        properties[key] = parameter_to_json_schema(child);
        if (child.required) {
          required.push(key);
        }
      }
      return {
        type: "object",
        ...(param.description ? { description: param.description } : {}),
        ...(Object.keys(properties).length ? { properties } : {}),
        ...(required.length ? { required } : {}),
      };
    }
    case "array":
      return {
        type: "array",
        ...(param.description ? { description: param.description } : {}),
        items: parameter_to_json_schema(param.items),
      };
    case "number":
      return {
        type: "number",
        ...(param.description ? { description: param.description } : {}),
      };
    case "boolean":
      return {
        type: "boolean",
        ...(param.description ? { description: param.description } : {}),
      };
    case "string":
      return "enum" in param && param.enum
        ? {
            type: "string",
            enum: param.enum,
            ...(param.description ? { description: param.description } : {}),
          }
        : { type: "string", ...(param.description ? { description: param.description } : {}) };
  }
}

function to_anthropic_tool(tool: ToolDefinition): Anthropic.Messages.ToolUnion {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const param of tool.parameters) {
    const schema = parameter_to_json_schema(param);
    if (param.description) {
      schema.description = param.description;
    }
    properties[param.name] = schema;
    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      ...(Object.keys(properties).length ? { properties } : {}),
      ...(required.length ? { required } : {}),
    },
  };
}

function from_anthropic_message(message: Partial<Anthropic.MessageParam>) {
  if (typeof message.content === "string") {
    return {
      role: message.role,
      content: [
        {
          type: "text",
          text: message.content,
        },
      ],
    } as Message;
  }
  return {
    role: message.role,
    content: (message.content ?? []).map((c) =>
      from_anthropic_content(c, Array.isArray(message.content) ? message.content : undefined),
    ),
  } as Message;
}

function from_anthropic_content(
  content: Partial<Anthropic.ContentBlockParam>,
  allContent?: Partial<Anthropic.ContentBlockParam>[],
) {
  switch (content.type) {
    case "text": {
      const { type: _, text, ...extended } = content;
      return {
        type: "text",
        text,
        extended,
      };
    }
    case "tool_use": {
      const { type: _, id, name, input, ...extended } = content;
      return {
        type: "tool",
        tool_request_id: id,
        tool: name,
        params: input as Record<string, unknown>,
        extended,
      };
    }
    case "tool_result": {
      const { type: _, tool_use_id, content: tool_content, ...extended } = content;
      let tool_name = "";
      if (allContent) {
        const matching = allContent.find(
          (c): c is Partial<Anthropic.Messages.ToolUseBlockParam> =>
            c.type === "tool_use" && "id" in c && c.id === tool_use_id,
        );
        if (matching) {
          tool_name = matching.name ?? "";
        }
      }
      return {
        type: "tool_result",
        tool_request_id: tool_use_id,
        tool: tool_name,
        result:
          typeof tool_content === "string"
            ? (() => {
                try {
                  return JSON.parse(tool_content as string);
                } catch {
                  return { text: tool_content };
                }
              })()
            : tool_content,
        extended,
      };
    }
    case "thinking": {
      const { type: _, thinking, ...extended } = content;
      return {
        type: "thinking",
        thought: thinking,
        extended,
      };
    }
    case "redacted_thinking": {
      const { type: _, ...extended } = content;
      return {
        type: "thinking",
        thought: extended.data,
        extended,
      };
    }
    default:
      return {
        type: "raw",
        model_kind: "anthropic",
        data: JSON.stringify(content),
      };
  }
}

function to_anthropic_message(message: Readonly<Message>) {
  return {
    role: message.role,
    content:
      message.content.length === 1 && message.content[0].type === "text"
        ? message.content[0].text
        : message.content.map((c) => to_anthropic_content(c)),
  };
}

function to_anthropic_content(content: Readonly<Content>) {
  switch (content.type) {
    case "text":
      return {
        type: "text",
        text: content.text,
        citations: Array.isArray(content.extended?.citations) ? content.extended.citations : [],
      };
    case "tool":
      return {
        type: "tool_use",
        id: content.tool_request_id,
        name: content.tool,
        input: content.params,
      };
    case "raw":
      if (content.model_kind !== "anthropic") {
        return {
          type: "text",
          text: content.data,
        };
      }
      try {
        return {
          ...JSON.parse(content.data),
        };
      } catch {
        return {
          data: content.data,
        };
      }
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: content.tool_request_id,
        is_error: content.result.result === false ? true : undefined,
        content: JSON.stringify(content.result),
      };
    case "thinking":
      if (!content.extended?.signature) {
        return {
          type: "text",
          text: content.thought,
        };
      }
      return {
        type: "thinking",
        thinking: content.thought,
        signature: content.extended?.signature,
      };
    default:
      throw new Error("unexpected content type");
  }
}

