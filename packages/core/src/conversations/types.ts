import type { CheckpointState, ProviderContextTransformer } from "../context-transformers/types.ts";
import type { Tool, ToolDefinition } from "../tools/types.ts";
import type { CancellationToken } from "../utils/async.ts";
import type { Conversation } from "./conversation.ts";

/**
 * Base interface for all content types.
 */
interface BaseContent {
  /** Optional unique identifier for this content block. */
  id?: string;
  /** Optional timestamp when this content was created. */
  timestamp?: number;
}

/**
 * Raw content that contains provider-specific data.
 */
export interface RawContent extends BaseContent {
  type: "raw";
  /** The kind of model provider this raw data belongs to. */
  model_kind: string;
  /** The raw serialized data from the provider. */
  data: string;
}

/**
 * Base interface for content that can be extended with custom properties.
 */
export interface ExtendableContent extends BaseContent {
  /** Optional custom properties that can be attached to this content. */
  extended?: Record<string, unknown>;
}

/**
 * Text content block.
 */
export interface TextContent extends ExtendableContent {
  type: "text";
  /** The text content. */
  text: string;
}

/**
 * Tool execution result content.
 *
 * @template TTool - The type of tool that produced this result.
 */
export interface ToolResultContent<TTool extends Tool = Tool> extends ExtendableContent {
  type: "tool_result";
  /** The name of the tool that was executed. */
  tool: string;
  /** The unique identifier matching the tool request. */
  tool_request_id: string;
  /** The result returned by the tool execution. */
  result: Awaited<ReturnType<TTool["execute"]>>;
}

/**
 * Content types that can appear in user messages.
 */
export type UserContent = RawContent | TextContent | ToolResultContent;

/**
 * Thinking/reasoning content from the assistant.
 */
export interface ThinkingMessageContent extends ExtendableContent {
  type: "thinking";
  /** The assistant's internal reasoning. */
  thought: string;
}

/**
 * Tool invocation request from the assistant.
 *
 * @template TTool - The type of tool being invoked.
 */
export interface ToolContent<TTool extends Tool = Tool> extends ExtendableContent {
  type: "tool";
  /** Unique identifier for this tool request. */
  tool_request_id: string;
  /** The name of the tool to invoke. */
  tool: string;
  /** The parameters to pass to the tool. */
  params: Parameters<TTool["execute"]>[0];
}

/**
 * Content types that can appear in assistant messages.
 */
export type AssistantContent = RawContent | TextContent | ThinkingMessageContent | ToolContent;

/**
 * Union of all content types.
 */
export type Content = UserContent | AssistantContent;

/**
 * A message from the user.
 */
export interface UserMessage {
  /** Optional unique identifier for this message. */
  id?: string;
  /** Optional timestamp when this message was created. */
  timestamp?: number;
  /** The role of the message sender. */
  role: "user";
  /** The content blocks in this message. */
  content: UserContent[];
}

/**
 * A message from the assistant.
 */
export interface AssistantMessage {
  /** Optional unique identifier for this message. */
  id?: string;
  /** Optional timestamp when this message was created. */
  timestamp?: number;
  /** The role of the message sender. */
  role: "assistant";
  /** The content blocks in this message. */
  content: AssistantContent[];
}

/**
 * Union of all message types.
 */
export type Message = UserMessage | AssistantMessage;

/**
 * Token usage information for a model request/response.
 */
export interface Usage {
  /** Number of tokens used to create cache. */
  cache_creation_input_tokens?: number | null;
  /** Number of cached input tokens read. */
  cache_read_input_tokens?: number | null;
  /** Number of input tokens consumed. */
  input_tokens?: number | null;
  /** Number of output tokens generated. */
  output_tokens?: number | null;
}

/**
 * Base data for any request.
 */
export type RequestData = { request_id?: string };

/**
 * Data for a prompt request that includes the user message.
 */
export type PromptRequestData = RequestData & { message: UserMessage };

/**
 * Streaming response data that includes usage information.
 */
export type CompletionStreamingResponseData = RequestData & {
  usage: Usage;
};

/**
 * Complete response data that includes stop reason and details.
 */
export type CompletionResponseData = CompletionStreamingResponseData & {
  /** The reason why the model stopped generating. */
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "error" | "other";
  /** Optional additional details about why the model stopped. */
  stop_details?: string;
};

/**
 * Represents a state change event.
 *
 * @template T - The type of state being changed.
 */
export type ChangeEvent<T> = { current: T; previous: T };

/**
 * Event containing raw data from the provider.
 */
export type RawEvent = { data: unknown };

/**
 * Raw event with an associated request ID.
 */
export type RawRequestEvent = RawEvent & RequestData;

/**
 * Event containing error information for a failed request.
 */
export type ErrorRequestEvent = PromptRequestData & { error: unknown };

/**
 * Event emitted when an infrastructure or lifecycle operation fails.
 *
 * Unlike {@link ErrorRequestEvent} (which is specific to model provider request failures),
 * this event covers operational failures such as session save errors, fork failures,
 * or cleanup failures.
 */
export interface LifecycleErrorEvent {
  /** The error that occurred. */
  error: unknown;
  /** A short identifier for the operation that failed (e.g., "save", "fork", "disconnect"). */
  operation: string;
  /** Optional additional context about the failure. */
  context?: Record<string, unknown>;
}

/**
 * Partial message completion event during streaming.
 */
export type PartialMessageCompletionEvent = CompletionStreamingResponseData & {
  message: Partial<AssistantMessage>;
};

/**
 * Complete message event when streaming finishes.
 */
export type FullMessageCompletionEvent = CompletionResponseData & {
  message: AssistantMessage;
};

/**
 * Partial content completion event during streaming.
 */
export type PartialContentCompletionEvent = PartialMessageCompletionEvent & {
  content: Partial<AssistantContent>;
};

/**
 * Complete content event when a content block finishes streaming.
 */
export type FullContentCompletionEvent = PartialMessageCompletionEvent & {
  content: AssistantContent;
};

/**
 * Events emitted by a Conversation instance.
 */
export interface ConversationEvents {
  /** Emitted when the conversation state changes. */
  state_change: [ChangeEvent<ConversationState>, Conversation];
  /** Emitted when a prompt is sent to the model. */
  prompt_send: [PromptRequestData, Conversation];
  /** Emitted when the assistant starts generating a message. */
  message_start: [PartialMessageCompletionEvent, Conversation];
  /** Emitted during message generation with partial updates. */
  message_update: [PartialMessageCompletionEvent, Conversation];
  /** Emitted when message generation completes. */
  message_complete: [FullMessageCompletionEvent, Conversation];
  /** Emitted when a content block starts streaming. */
  content_start: [PartialContentCompletionEvent, Conversation];
  /** Emitted during content block streaming with updates. */
  content_update: [PartialContentCompletionEvent, Conversation];
  /** Emitted when a content block completes. */
  content_complete: [FullContentCompletionEvent, Conversation];
  /** Emitted when a request succeeds. */
  request_success: [PromptRequestData, object, Conversation];
  /** Emitted when a request fails. */
  request_error: [ErrorRequestEvent, object, Conversation];
  /** Emitted before a request is sent to the provider. */
  before_request: [RawEvent, Conversation];
  /** Emitted with raw request data. */
  raw_request: [RawRequestEvent, Conversation];
  /** Emitted with raw response data. */
  raw_response: [RawRequestEvent, Conversation];
  /** Emitted with raw streaming data. */
  raw_stream: [RawRequestEvent, Conversation];
  /** Emitted when a checkpoint operation begins. The payload is the child conversation used for summarization. */
  checkpoint_begin: [Conversation, Conversation];
  /** Emitted when a checkpoint operation completes. The payload is the new checkpoint state. */
  checkpoint_complete: [CheckpointState, Conversation];
  /** Emitted when a child conversation is created. */
  create_child: [Conversation, Conversation];
  /** Emitted when a child conversation emits an event. */
  child_event: [
    {
      [E in keyof ConversationEvents]: {
        event_name: E;
        event_args: ConversationEvents[E];
      };
    }[keyof ConversationEvents],
    Conversation,
  ];
  /** Emitted when an infrastructure or lifecycle operation fails. */
  lifecycle_error: [LifecycleErrorEvent, Conversation];
  /** Emitted when the conversation is disposed. */
  dispose: [Conversation];
}

/**
 * Interface for receiving streaming events from model providers.
 */
export interface StreamReceiver {
  /** Called when a message starts streaming. */
  start_message: (event: Omit<PartialMessageCompletionEvent, "request_id">) => void;
  /** Called with message updates during streaming. */
  update_message: (event: Omit<PartialMessageCompletionEvent, "request_id">) => void;
  /** Called when a message completes. */
  complete_message: (event: Omit<FullMessageCompletionEvent, "request_id">) => void;
  /** Called when a content block starts. */
  start_content: (event: Omit<PartialContentCompletionEvent, "request_id">) => void;
  /** Called with content block updates. */
  update_content: (event: Omit<PartialContentCompletionEvent, "request_id">) => void;
  /** Called when a content block completes. */
  complete_content: (event: Omit<FullContentCompletionEvent, "request_id">) => void;
  /** Called when an error occurs. */
  error: (error: unknown) => void;
  /** Called before a request is sent. */
  before_request: (data: unknown) => void;
  /** Called with raw request data. */
  request_raw: (data: unknown) => void;
  /** Called with raw response data. */
  response_raw: (data: unknown) => void;
  /** Called with raw stream chunks. */
  stream_raw: (data: unknown) => void;
  /** Called when the stream is cancelled. */
  cancel: () => void;
}

/**
 * Possible states of a conversation.
 */
export type ConversationState =
  | "idle"
  | "awaiting_response"
  | "streaming_response"
  | "stopping"
  | "disposed";

/**
 * Request data sent to a model provider.
 */
export interface ModelRequest {
  /** The conversation messages. */
  messages: Message[];
  /** Available tool definitions. */
  tools: ToolDefinition[];
  /** Optional system prompt. */
  system?: string;
}

/**
 * Interface that model providers must implement.
 */
export interface ModelProvider {
  /**
   * Provider-level context transformers that normalize provider-specific quirks.
   *
   * These run before conversation-level transformers and are read fresh on
   * every request, allowing model routing providers to swap them at runtime.
   */
  context_transformers?: ProviderContextTransformer[];

  /**
   * Executes a request against the model.
   *
   * @param request - The model request containing messages and tools.
   * @param receiver - The stream receiver for handling response events.
   * @param cancellation - Token for cancelling the request.
   * @returns A promise that resolves when the request completes.
   */
  execute_request(
    request: ModelRequest,
    receiver: StreamReceiver,
    cancellation: CancellationToken,
  ): Promise<void>;

  /**
   * Creates a clone of this provider.
   *
   * @returns A new instance of the provider with the same configuration.
   */
  clone(): ModelProvider;
}
