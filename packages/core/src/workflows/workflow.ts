import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";

import {
  AssistantContent,
  AssistantMessage,
  Conversation,
  FullMessageCompletionEvent,
  Message,
  PromptRequestData,
  ToolResultContent,
} from "../conversations/index.ts";
import type { ToolContext, ToolClass } from "../tools/types.ts";
import { WorkflowEndEvent, WorkflowEvents } from "./types.ts";
import { WorkflowState } from "./index.ts";
import { UserMessage } from "../conversations/types.ts";

/**
 * Manages an agentic workflow with automatic tool execution.
 *
 * A Workflow wraps a Conversation and automatically executes tools requested
 * by the model, continuing the conversation until completion or error.
 */
export class Workflow {
  readonly #event_emitter: EventEmitter<WorkflowEvents>;
  readonly #conversation: Conversation;
  readonly #context_data: Record<string, unknown>;
  readonly #parent?: Workflow;
  readonly #messages: Readonly<Message>[] = [];
  readonly #queued_messages: string[] = [];

  #id: string = randomUUID();
  #state: WorkflowState = "idle";
  #tool_context: ToolContext | undefined;

  /**
   * Creates a new workflow instance.
   *
   * @param conversation - The conversation to manage.
   * @param options - Optional configuration.
   * @param options.context_data - Custom data to pass to tools via ToolContext.
   * @param options.parent - Parent workflow if this is a child workflow.
   */
  constructor(
    conversation: Conversation,
    options?: { context_data?: Record<string, unknown>; parent?: Workflow },
  ) {
    this.#event_emitter = new EventEmitter<WorkflowEvents>();
    this.#event_emitter.setMaxListeners(0);

    this.#conversation = conversation;
    this.#context_data = options?.context_data ?? {};
    this.#parent = options?.parent;

    this.#conversation.on("prompt_send", this.#on_prompt_send);
    this.#conversation.on("message_complete", this.#on_message_complete);
    this.#conversation.on("request_error", this.#on_request_error);
    this.#conversation.once("dispose", this.#on_conversation_dispose);
    this.#parent?.once("workflow_end", this.#on_parent_workflow_end);
  }

  /**
   * The unique identifier for this workflow.
   */
  get id(): string {
    return this.#id;
  }
  set id(value: string) {
    this.#id = value;
  }

  /**
   * The current state of the workflow.
   */
  get state() {
    return this.#state;
  }

  /**
   * The conversation being managed by this workflow.
   */
  get conversation() {
    return this.#conversation;
  }

  /**
   * The parent workflow, if this is a child workflow.
   */
  get parent() {
    return this.#parent;
  }

  /**
   * The message history tracked by this workflow.
   */
  get messages() {
    return Object.freeze([...this.#messages]);
  }

  /**
   * Messages queued for sending after the current response completes.
   */
  get queued_messages() {
    return [...this.#queued_messages];
  }

  /**
   * Disposes the workflow and releases all resources.
   *
   * This method is called automatically when using the `using` keyword.
   */
  [Symbol.dispose]() {
    this.#conversation.off("prompt_send", this.#on_prompt_send);
    this.#conversation.off("message_complete", this.#on_message_complete);
    this.#conversation.off("request_error", this.#on_request_error);
    this.#conversation.off("dispose", this.#on_conversation_dispose);
    this.#parent?.off("workflow_end", this.#on_parent_workflow_end);

    this.#event_emitter.emit("dispose", this);
    this.#set_state("disposed");
    this.#event_emitter.removeAllListeners();
  }

  /**
   * Registers a one-time event listener.
   *
   * @template E - The event name type.
   * @param event - The name of the event to listen for.
   * @param listener - The callback function to invoke when the event occurs.
   * @returns This workflow instance for chaining.
   */
  once<E extends keyof WorkflowEvents>(
    event: E,
    listener: E extends keyof WorkflowEvents ? (...args: WorkflowEvents[E]) => void : never,
  ): this {
    if (this.#state === "disposed") {
      throw new Error("invalid state");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.#event_emitter as any).once(event, listener);
    return this;
  }

  /**
   * Registers a persistent event listener.
   *
   * @template E - The event name type.
   * @param event - The name of the event to listen for.
   * @param listener - The callback function to invoke when the event occurs.
   * @returns This workflow instance for chaining.
   */
  on<E extends keyof WorkflowEvents>(
    event: E,
    listener: E extends keyof WorkflowEvents ? (...args: WorkflowEvents[E]) => void : never,
  ): this {
    if (this.#state === "disposed") {
      throw new Error("invalid state");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.#event_emitter as any).on(event, listener);
    return this;
  }

  /**
   * Removes an event listener.
   *
   * @template E - The event name type.
   * @param event - The name of the event.
   * @param listener - The callback function to remove.
   * @returns This workflow instance for chaining.
   */
  off<E extends keyof WorkflowEvents>(
    event: E,
    listener: E extends keyof WorkflowEvents ? (...args: WorkflowEvents[E]) => void : never,
  ): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.#event_emitter as any).off(event, listener);
    return this;
  }

  /**
   * Starts the workflow execution.
   *
   * @param message - Optional initial user message to begin the workflow.
   */
  start(message?: UserMessage) {
    if (this.#state !== "idle") {
      throw new Error("invalid state");
    }
    if (message) {
      this.#messages.push(message);
      this.#event_emitter.emit("workflow_update", this);
    }
    this.#set_state("busy");
  }

  /**
   * Cancels the workflow execution.
   *
   * This will cancel any in-progress model response and emit a workflow_end event.
   */
  cancel() {
    if (this.#state === "disposed") {
      throw new Error("invalid state");
    }
    if (
      this.#conversation.state === "awaiting_response" ||
      this.#conversation.state === "streaming_response"
    ) {
      this.#conversation.cancel_response();
    }
    this.#set_state("idle");
    this.#event_emitter.emit("workflow_end", { reason: "cancel" }, this);
    this[Symbol.dispose]();
  }

  /**
   * Creates a child workflow with a different conversation.
   *
   * Child events are propagated to the parent as "child_workflow_event" events.
   *
   * @param conversation - The conversation for the child workflow.
   * @param id - Optional custom ID for the child workflow.
   * @param context_data - Additional context data to merge with this workflow's context data.
   * @returns The newly created child workflow.
   */
  spawn_child(conversation: Conversation, id?: string, context_data?: Record<string, unknown>) {
    if (this.#state === "disposed") {
      throw new Error("invalid state");
    }
    const merged_context = context_data
      ? { ...this.#context_data, ...context_data }
      : this.#context_data;
    const child = new Workflow(conversation, { context_data: merged_context, parent: this });
    if (id) {
      child.id = id;
    }

    this.#attach_child_event(child, "state_change");
    this.#attach_child_event(child, "workflow_update");
    this.#attach_child_event(child, "workflow_end");
    this.#attach_child_event(child, "child_workflow_begin");
    this.#attach_child_event(child, "child_workflow_event");
    this.#attach_child_event(child, "message_queued");
    this.#attach_child_event(child, "message_dequeued");
    this.#attach_child_event(child, "queue_cleared");
    this.#attach_child_event(child, "lifecycle_error");
    this.#attach_child_event(child, "dispose");

    this.#event_emitter.emit("child_workflow_begin", child, this);

    return child;
  }

  /**
   * Adds a message to the queue for sending after the current response completes.
   *
   * @param message - The text message to queue.
   */
  queue_message(message: string) {
    if (this.#state === "disposed") {
      throw new Error("invalid state");
    }
    this.#queued_messages.push(message);
    this.#event_emitter.emit("message_queued", message, this);
  }

  /**
   * Clears all queued messages.
   */
  clear_queue() {
    if (this.#state === "disposed") {
      throw new Error("invalid state");
    }
    this.#queued_messages.length = 0;
    this.#event_emitter.emit("queue_cleared", this);
  }

  #set_state(state: WorkflowState) {
    if (this.#state === state) {
      return;
    }
    const previous = this.state;

    this.#state = state;
    this.#event_emitter.emit("state_change", { previous, current: this.#state }, this);
  }

  async #execute_tools(message: AssistantMessage) {
    const tool_calls = (message.content as AssistantContent[]).filter(
      (c): c is Extract<AssistantContent, { type: "tool" }> => c.type === "tool",
    );

    const batches: (typeof tool_calls)[] = [];
    let current_batch: typeof tool_calls = [];

    for (const call of tool_calls) {
      const tool_class = this.conversation.toolkit.find(
        (t: ToolClass) => t.get_definition().name === call.tool,
      );
      const is_parallel = tool_class?.get_definition().parallelizable !== false;

      if (!is_parallel) {
        if (current_batch.length > 0) {
          batches.push(current_batch);
          current_batch = [];
        }
        batches.push([call]);
      } else {
        current_batch.push(call);
      }
    }
    if (current_batch.length > 0) {
      batches.push(current_batch);
    }

    const results: ToolResultContent[] = [];

    for (const batch of batches) {
      const batch_results = await Promise.all(
        batch.map(async (call) => {
          const tool_class = this.conversation.toolkit.find(
            (t: ToolClass) => t.get_definition().name === call.tool,
          );

          if (tool_class) {
            if (!this.#tool_context) {
              this.#tool_context = {
                ...this.#context_data,
                conversation: this.conversation,
                workflow: this,
              };
            }
            const context = this.#tool_context;
            const tool = new tool_class(context);
            try {
              const result = await tool.execute(call.params);
              return {
                type: "tool_result" as const,
                tool: call.tool,
                tool_request_id: call.tool_request_id,
                result,
              };
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : "Tool execution failed";
              return {
                type: "tool_result" as const,
                tool: call.tool,
                tool_request_id: call.tool_request_id,
                result: { result: false as const, message },
              };
            }
          }

          return {
            type: "tool_result" as const,
            tool: call.tool,
            tool_request_id: call.tool_request_id,
            result: { result: false as const, message: "invalid tool" },
          };
        }),
      );

      results.push(...batch_results);

      if (this.#state !== "busy") {
        return;
      }
    }

    await this.conversation.send_message(results);
  }

  #attach_child_event(child: Workflow, event_name: keyof WorkflowEvents) {
    const handler = (...args: unknown[]) => {
      this.#event_emitter.emit(
        "child_workflow_event",
        {
          event_name,
          event_args: args,
        } as WorkflowEvents["child_workflow_event"][0],
        this,
      );
    };
    child.on(event_name, handler);
    child.once("dispose", () => setImmediate(() => child.off(event_name, handler)));
  }

  #on_prompt_send = ({ message }: PromptRequestData) => {
    this.#messages.push(message);
    this.#event_emitter.emit("workflow_update", this);
  };

  #on_message_complete = async (event: FullMessageCompletionEvent) => {
    try {
      this.#messages.push(event.message);
      this.#event_emitter.emit("workflow_update", this);

      if (event.stop_reason === "tool_use") {
        await this.#execute_tools(event.message);
      } else {
        const queued_message = this.#queued_messages.shift();
        if (queued_message) {
          this.#event_emitter.emit("message_dequeued", queued_message, this);
          await this.#conversation.prompt(queued_message);
        } else {
          this.#set_state("idle");
          this.#event_emitter.emit("workflow_end", { reason: "complete" }, this);
          this[Symbol.dispose]();
        }
      }
    } catch {
      this.#set_state("idle");
      this.#event_emitter.emit("workflow_end", { reason: "error" }, this);
      this[Symbol.dispose]();
    }
  };

  #on_request_error = () => {
    this.#set_state("idle");
    this.#event_emitter.emit("workflow_end", { reason: "error" }, this);
    this[Symbol.dispose]();
  };

  #on_conversation_dispose = () => this[Symbol.dispose]();

  #on_parent_workflow_end = (event: WorkflowEndEvent) => {
    if (event.reason === "cancel") {
      this.cancel();
    }
  };
}
