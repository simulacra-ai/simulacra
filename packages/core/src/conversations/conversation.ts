import crypto from "node:crypto";
import EventEmitter from "node:events";
import { setImmediate } from "node:timers/promises";

import type {
  CheckpointState,
  ContextTransformer,
  TransformContext,
} from "../context-transformers/types.ts";
import type { CheckpointConfig, SummarizationStrategy } from "../checkpoints/types.ts";
import { DefaultSummarizationStrategy } from "../checkpoints/default-summarization-strategy.ts";
import { CheckpointContextTransformer } from "../context-transformers/checkpoint-context-transformer.ts";
import { CompositeContextTransformer } from "../context-transformers/composite-context-transformer.ts";
import { ToolContextTransformer } from "../context-transformers/tool-context-transformer.ts";
import type { ToolClass } from "../tools/types.ts";
import { getDefaultPolicy } from "../policies/default-policy.ts";
import type { Policy, PolicyResult } from "../policies/types.ts";
import {
  AssistantMessage,
  ChangeEvent,
  Content,
  ConversationEvents,
  ConversationState,
  Message,
  ModelProvider,
  PromptRequestData,
  TextContent,
  UserContent,
  UserMessage,
} from "./types.ts";
import { CancellationTokenSource } from "../utils/async.ts";
import { StreamListener } from "./stream-listener.ts";

/**
 * Manages a conversation with a language model.
 *
 * The Conversation class handles message exchange, tool execution coordination,
 * event emission, and state management for interactions with language models.
 */
export class Conversation {
  readonly #event_emitter: EventEmitter<ConversationEvents>;

  readonly #provider: ModelProvider;
  readonly #policy: Policy;
  readonly #context_transformer: ContextTransformer;
  readonly #summarization_strategy: SummarizationStrategy;

  #id: string = crypto.randomUUID();
  #state: ConversationState = "idle";
  #system: string | undefined;
  #toolkit: ToolClass[] = [];
  #messages: Readonly<Message>[] = [];
  #checkpoint_state: CheckpointState | undefined;
  #is_checkpoint = false;

  /**
   * Creates a new conversation instance.
   *
   * @param provider - The model provider for executing requests.
   * @param policy - The policy for controlling request execution (default: retry + rate limiting).
   * @param context_transformer - Transformer for modifying messages before sending (default: noop).
   * @param summarization_strategy - Strategy for generating checkpoint summaries (default: DefaultSummarizationStrategy).
   */
  constructor(
    provider: ModelProvider,
    policy: Policy = getDefaultPolicy(),
    context_transformer: ContextTransformer = new CompositeContextTransformer([
      new ToolContextTransformer(),
      new CheckpointContextTransformer(),
    ]),
    summarization_strategy: SummarizationStrategy = new DefaultSummarizationStrategy(),
  ) {
    this.#event_emitter = new EventEmitter<ConversationEvents>();
    this.#event_emitter.setMaxListeners(0);

    this.#provider = provider;
    this.#policy = policy;
    this.#context_transformer = context_transformer;
    this.#summarization_strategy = summarization_strategy;
  }

  /**
   * The unique identifier for this conversation.
   */
  get id(): string {
    return this.#id;
  }
  set id(value: string) {
    this.#id = value;
  }

  /**
   * The current state of the conversation.
   */
  get state(): ConversationState {
    return this.#state;
  }

  /**
   * The system prompt for this conversation.
   */
  get system(): string | undefined {
    return this.#system;
  }
  set system(value: string | undefined) {
    this.#system = value;
  }

  /**
   * The collection of tools available to the model in this conversation.
   */
  get toolkit(): Readonly<ToolClass[]> {
    return Object.freeze([...this.#toolkit]);
  }
  set toolkit(value: ToolClass[]) {
    if (this.#state === "disposed") {
      throw new Error("invalid state");
    }
    this.#toolkit = [...value];
  }

  /**
   * The conversation message history.
   */
  get messages(): Readonly<Readonly<Message>[]> {
    return Object.freeze([...this.#messages.map((m) => Object.freeze({ ...m }))]);
  }

  /**
   * The most recent checkpoint state, if any.
   */
  get checkpoint_state(): Readonly<CheckpointState> | undefined {
    return this.#checkpoint_state ? Object.freeze({ ...this.#checkpoint_state }) : undefined;
  }
  set checkpoint_state(value: CheckpointState | undefined) {
    this.#checkpoint_state = value;
  }

  /**
   * Whether this conversation is a checkpoint session.
   */
  get is_checkpoint() {
    return this.#is_checkpoint;
  }

  /**
   * Disposes the conversation and releases all resources.
   *
   * This method is called automatically when using the `using` keyword.
   * Emits a dispose event and transitions to the disposed state.
   */
  [Symbol.dispose]() {
    if (this.state === "disposed") {
      throw new Error("invalid state");
    }
    const previous = this.#state;

    this.#event_emitter.emit("dispose", this);
    this.#state = "disposed";
    this.#event_emitter.emit("state_change", { current: this.#state, previous }, this);
    this.#event_emitter.removeAllListeners();
  }

  /**
   * Sends a text prompt to the model.
   *
   * @param prompt - The text prompt to send.
   * @returns A promise that resolves with the request data, or undefined if cancelled.
   */
  async prompt(prompt: string) {
    return await this.send_message([
      {
        timestamp: Date.now(),
        type: "text",
        text: prompt,
      },
    ]);
  }

  /**
   * Sends a message with custom content to the model.
   *
   * @param contents - The content blocks to include in the message.
   * @returns A promise that resolves with the request data, or undefined if cancelled.
   */
  async send_message(contents: UserContent[]) {
    if (this.state !== "idle") {
      throw new Error("invalid state");
    }
    let prompt_message: UserMessage = {
      timestamp: Date.now(),
      role: "user",
      content: contents
        .map((c) => ({
          timestamp: Date.now(),
          ...c,
        }))
        .map((c) => ({
          ...c,
          id: c.id ?? crypto.createHash("sha1").update(JSON.stringify(c)).digest("hex"),
        })),
    };
    prompt_message = {
      ...prompt_message,
      id:
        prompt_message.id ??
        crypto.createHash("sha1").update(JSON.stringify(prompt_message)).digest("hex"),
    };

    let request_id: string | undefined;
    let result: PromptRequestData | undefined;
    let policy_result: PolicyResult<PromptRequestData | undefined> | undefined;
    try {
      const stream_listener = new StreamListener(async ({ event, payload }) => {
        switch (event) {
          case "start_message": {
            const [{ message, usage }] = payload;
            this.#set_state("streaming_response");
            this.#event_emitter.emit("message_start", { request_id, usage, message }, this);
            break;
          }
          case "update_message": {
            const [{ message, usage }] = payload;
            this.#event_emitter.emit("message_update", { request_id, usage, message }, this);
            break;
          }
          case "complete_message": {
            const [data] = payload;
            let message = identify_message(data.message);
            for (const t of this.#provider.context_transformers ?? []) {
              if (t.transform_completion) {
                message = await t.transform_completion(message);
              }
            }
            message = await this.#context_transformer.transform_completion(message);
            const has_tool_calls = message.content.some((c) => c.type === "tool");
            const stop_reason = has_tool_calls ? "tool_use" : data.stop_reason;
            this.#set_state("idle");
            this.#messages.push(prompt_message, message);
            this.#event_emitter.emit(
              "message_complete",
              { request_id, ...data, message, stop_reason },
              this,
            );
            break;
          }
          case "start_content": {
            const [data] = payload;
            this.#event_emitter.emit("content_start", { request_id, ...data }, this);
            break;
          }
          case "update_content": {
            const [data] = payload;
            this.#event_emitter.emit("content_update", { request_id, ...data }, this);
            break;
          }
          case "complete_content": {
            const [data] = payload;
            this.#event_emitter.emit("content_complete", { request_id, ...data }, this);
            break;
          }
          case "error": {
            stream_listener[Symbol.dispose]();
            const [error] = payload;
            if (this.state !== "disposed") {
              this.#set_state("idle");
            }
            this.#event_emitter.emit(
              "request_error",
              { request_id, message: prompt_message, error },
              {},
              this,
            );
            break;
          }
          case "before_request": {
            const [data] = payload;
            this.#event_emitter.emit("before_request", { data }, this);
            break;
          }
          case "request_raw": {
            const [data] = payload;
            this.#event_emitter.emit("raw_request", { request_id, data }, this);
            break;
          }
          case "response_raw": {
            const [data] = payload;
            this.#event_emitter.emit("raw_response", { request_id, data }, this);
            break;
          }
          case "stream_raw": {
            const [data] = payload;
            this.#event_emitter.emit("raw_stream", { request_id, data }, this);
            break;
          }
          case "cancel": {
            stream_listener[Symbol.dispose]();
            if (this.state !== "disposed") {
              this.#set_state("idle");
            }
            break;
          }
        }
      });
      using source = new CancellationTokenSource();

      const on_state_change = ({ current }: ChangeEvent<ConversationState>) => {
        if (current === "stopping") {
          if (!source.is_cancelled) {
            source.cancel();
          }
        }
        if (current === "idle" || current === "disposed") {
          this.off("state_change", on_state_change);
        }
      };
      this.on("state_change", on_state_change);

      const transformed_messages = await this.#get_prompt_context([
        ...this.#messages,
        prompt_message,
      ]);
      const tool_definitions = this.#toolkit.map((t) => t.get_definition());

      // Policies are intentionally scoped to the initial request and connection.
      // Mid-stream errors are not handled by the policy; they surface as events
      // through stream_listener.
      const result_promise = this.#policy.execute(source.token, async () => {
        await this.#provider.execute_request(
          {
            messages: transformed_messages,
            tools: tool_definitions,
            system: this.#system,
          },
          stream_listener.create_receiver(),
          source.token,
        );
        return { message: prompt_message } as PromptRequestData;
      });

      this.#event_emitter.emit("prompt_send", { message: prompt_message }, this);
      this.#set_state("awaiting_response");

      policy_result = await Promise.race([
        result_promise,
        new Promise<undefined>((resolve) => {
          const on_state_change = ({ current }: ChangeEvent<ConversationState>) => {
            if (current === "stopping") {
              stream_listener[Symbol.dispose]();
              resolve(undefined);
            } else if (current === "disposed") {
              stream_listener[Symbol.dispose]();
              resolve(undefined);
            } else if (current === "streaming_response") {
              this.off("state_change", on_state_change);
            }
          };
          this.on("state_change", on_state_change);
        }),
      ]);
      request_id = request_id ?? crypto.randomUUID();
      result = {
        message: prompt_message,
        request_id,
      };
      if (policy_result) {
        if (!policy_result.result) {
          throw policy_result.error;
        }
        result = { ...result, ...policy_result.value };
        this.#event_emitter.emit("request_success", result, policy_result.metadata ?? {}, this);
      } else {
        if (this.#state !== "disposed") {
          this.#set_state("idle");
        }
      }
    } catch (error) {
      this.#event_emitter.emit(
        "request_error",
        { request_id, message: prompt_message, error },
        {},
        this,
      );
      if (this.#state !== "disposed") {
        this.#set_state("idle");
      }
    }
    return result;
  }

  /**
   * Registers a one-time event listener.
   *
   * @template E - The event name type.
   * @param event_name - The name of the event to listen for.
   * @param listener - The callback function to invoke when the event occurs.
   */
  once<E extends keyof ConversationEvents>(
    event_name: E,
    listener: E extends keyof ConversationEvents ? (...arg: ConversationEvents[E]) => void : never,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.#event_emitter as any).once(event_name, listener);
  }

  /**
   * Registers a persistent event listener.
   *
   * @template E - The event name type.
   * @param event_name - The name of the event to listen for.
   * @param listener - The callback function to invoke when the event occurs.
   */
  on<E extends keyof ConversationEvents>(
    event_name: E,
    listener: E extends keyof ConversationEvents ? (...arg: ConversationEvents[E]) => void : never,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.#event_emitter as any).on(event_name, listener);
  }

  /**
   * Removes an event listener.
   *
   * @template E - The event name type.
   * @param event_name - The name of the event.
   * @param listener - The callback function to remove.
   */
  off<E extends keyof ConversationEvents>(
    event_name: E,
    listener: E extends keyof ConversationEvents ? (...arg: ConversationEvents[E]) => void : never,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.#event_emitter as any).off(event_name, listener);
  }

  /**
   * Cancels an in-progress model response.
   *
   * Transitions the conversation to the "stopping" state, which triggers
   * cancellation of the underlying request.
   */
  cancel_response() {
    if (this.state === "idle" || this.state === "disposed") {
      throw new Error("invalid state");
    }
    this.#set_state("stopping");
  }

  /**
   * Clears all messages from the conversation history.
   *
   * Can only be called when the conversation is idle.
   */
  clear(): void {
    if (this.state !== "idle") {
      throw new Error("invalid state");
    }
    this.#messages = [];
    this.#set_state("idle");
  }

  /**
   * Loads messages into the conversation history.
   *
   * @param messages - The messages to load.
   */
  load(messages: Message[]) {
    if (this.state !== "idle") {
      throw new Error("invalid state");
    }
    this.#messages = [...messages.map((m) => Object.freeze({ ...m }))];
  }

  /**
   * Creates a child conversation that inherits configuration from this conversation.
   *
   * Child events are propagated to the parent as "child_event" events.
   *
   * @param fork_session - Whether to copy the current message history to the child.
   * @param id - Optional custom ID for the child conversation.
   * @param system_prompt - Optional system prompt override for the child.
   * @param is_checkpoint - Whether this child is a checkpoint summarization session.
   * @returns The newly created child conversation.
   */
  spawn_child(
    fork_session?: boolean,
    id?: string,
    system_prompt?: string,
    is_checkpoint?: boolean,
  ) {
    const child = new Conversation(
      this.#provider.clone(),
      this.#policy,
      this.#context_transformer,
      this.#summarization_strategy,
    );
    if (id) {
      child.id = id;
    }
    if (system_prompt) {
      child.system = system_prompt;
    }
    if (fork_session) {
      child.load(this.#messages);
    }
    if (is_checkpoint) {
      child.#is_checkpoint = true;
    }
    this.#attach_child_event(child, "state_change");
    this.#attach_child_event(child, "checkpoint_begin");
    this.#attach_child_event(child, "checkpoint_complete");
    this.#attach_child_event(child, "prompt_send");
    this.#attach_child_event(child, "message_start");
    this.#attach_child_event(child, "message_update");
    this.#attach_child_event(child, "message_complete");
    this.#attach_child_event(child, "content_start");
    this.#attach_child_event(child, "content_update");
    this.#attach_child_event(child, "content_complete");
    this.#attach_child_event(child, "request_success");
    this.#attach_child_event(child, "request_error");
    this.#attach_child_event(child, "before_request");
    this.#attach_child_event(child, "raw_request");
    this.#attach_child_event(child, "raw_response");
    this.#attach_child_event(child, "raw_stream");
    this.#attach_child_event(child, "create_child");
    this.#attach_child_event(child, "child_event");
    this.#attach_child_event(child, "lifecycle_error");
    this.#attach_child_event(child, "dispose");

    this.#event_emitter.emit("create_child", child, this);

    return child;
  }

  /**
   * Creates a checkpoint summarizing the conversation so far.
   *
   * Spawns an ephemeral child conversation, sends the checkpoint prompt,
   * and stores the resulting summary as the new checkpoint state.
   *
   * Requires a CheckpointContextTransformer (or composite that includes one)
   * in the context transformer pipeline for the checkpoint state to take effect
   * on subsequent prompts.
   *
   * @param config - Optional checkpoint configuration.
   * @returns The new checkpoint state.
   */
  async checkpoint(config?: CheckpointConfig): Promise<CheckpointState> {
    if (this.state !== "idle") {
      throw new Error("invalid state");
    }
    if (this.#messages.length === 0) {
      throw new Error("no messages to checkpoint");
    }

    const messages_since = this.#get_messages_since_checkpoint();
    if (messages_since.length === 0) {
      throw new Error("no new messages since last checkpoint");
    }
    const prompt_messages = this.#summarization_strategy.build_prompt({
      session_id: this.#id,
      messages: messages_since,
      previous_checkpoint: this.#checkpoint_state,
      system: this.#system,
      context: config?.context,
    });

    const child = this.spawn_child(false, undefined, undefined, true);
    this.#event_emitter.emit("checkpoint_begin", child, this);
    try {
      if (prompt_messages.length > 1) {
        child.load(prompt_messages.slice(0, -1));
      }

      const last = prompt_messages[prompt_messages.length - 1];
      if (last.role !== "user") {
        throw new Error("checkpoint prompt strategy must return a user message last");
      }
      const response_promise = new Promise<AssistantMessage>((resolve, reject) => {
        child.once("message_complete", ({ message }) => resolve(message));
        child.once("request_error", ({ error }) =>
          reject(error instanceof Error ? error : new Error(String(error))),
        );
      });

      await child.send_message(last.content);
      const response = await response_promise;

      const summary = response.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      if (!summary) {
        throw new Error("checkpoint produced an empty summary");
      }

      const boundary = this.#messages[this.#messages.length - 1];
      if (!boundary.id) {
        throw new Error("boundary message has no id");
      }

      const state: CheckpointState = {
        message_id: boundary.id,
        summary,
      };

      this.#checkpoint_state = state;
      this.#event_emitter.emit("checkpoint_complete", state, this);
      return state;
    } finally {
      if (child.state !== "disposed") {
        child[Symbol.dispose]();
      }
    }
  }

  #get_messages_since_checkpoint(): Readonly<Message>[] {
    const checkpointState = this.#checkpoint_state;
    if (!checkpointState) {
      return [...this.#messages];
    }
    const idx = this.#messages.findIndex((m) => m.id === checkpointState.message_id);
    if (idx === -1) {
      return [...this.#messages];
    }
    return this.#messages.slice(idx + 1);
  }

  #set_state(value: ConversationState) {
    if (this.#state === "disposed" || value === "disposed") {
      throw new Error("invalid state");
    }
    if (this.#state !== value) {
      const previous = this.#state;
      this.#state = value;
      this.#event_emitter.emit(
        "state_change",
        {
          current: value,
          previous,
        },
        this,
      );
    }
  }

  async #get_prompt_context(messages: Message[]): Promise<Message[]> {
    for (const t of this.#provider.context_transformers ?? []) {
      if (t.transform_prompt) {
        messages = await t.transform_prompt(messages);
      }
    }
    const context: TransformContext = { checkpoint: this.#checkpoint_state };
    return await this.#context_transformer.transform_prompt(messages, context);
  }

  #attach_child_event(child: Conversation, event_name: keyof ConversationEvents) {
    const handler = (...args: unknown[]) => {
      this.#event_emitter.emit(
        "child_event",
        {
          event_name,
          event_args: args,
        } as ConversationEvents["child_event"][0],
        this,
      );
    };
    child.on(event_name, handler);
    child.once("dispose", () => setImmediate(() => child.off(event_name, handler)));
  }
}

function identify_message<T extends Partial<Message>>(message: T): T {
  const content = message.content?.map(identify_content);
  const id =
    message.id ??
    crypto
      .createHash("sha1")
      .update(JSON.stringify({ ...message, content }))
      .digest("hex");
  return {
    timestamp: Date.now(),
    ...message,
    content,
    id,
  } as T;
}

function identify_content<T extends Partial<Content>>(content: T): T {
  const id = content.id ?? crypto.createHash("sha1").update(JSON.stringify(content)).digest("hex");
  return {
    timestamp: Date.now(),
    ...content,
    id,
  } as T;
}
