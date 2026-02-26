import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";

import { Conversation } from "../conversations/index.ts";
import { WorkflowEvents, WorkflowManagerEvents, WorkflowState } from "./types.ts";
import { Workflow } from "./workflow.ts";
import { PromptRequestData } from "../conversations/types.ts";

/**
 * Automatically manages workflow lifecycle for a conversation.
 *
 * The WorkflowManager creates a new Workflow instance whenever a message is sent
 * to its associated conversation, eliminating the need for manual workflow management.
 */
export class WorkflowManager {
  readonly #event_emitter = new EventEmitter<WorkflowManagerEvents>();
  readonly #conversation: Conversation;
  readonly #context_data: Record<string, unknown>;

  #state: WorkflowState = "idle";
  #current_workflow?: Workflow;

  /**
   * Creates a new workflow manager instance.
   *
   * @param conversation - The conversation to manage workflows for.
   * @param options - Optional configuration.
   * @param options.context_data - Custom data to pass to tools via ToolContext.
   */
  constructor(conversation: Conversation, options?: { context_data?: Record<string, unknown> }) {
    this.#conversation = conversation;
    this.#context_data = options?.context_data ?? {};

    this.#conversation.on("prompt_send", this.#on_prompt_send);
    this.#conversation.on("checkpoint_begin", this.#on_checkpoint_begin);
    this.#conversation.once("dispose", this.#on_conversation_dispose);
  }

  /**
   * The current state of the workflow manager.
   */
  get state() {
    return this.#state;
  }

  /**
   * The conversation being managed.
   */
  get conversation() {
    return this.#conversation;
  }

  /**
   * The currently active workflow, if any.
   */
  get current_workflow(): Workflow | undefined {
    return this.#current_workflow;
  }

  /**
   * Disposes the workflow manager and releases all resources.
   *
   * This method is called automatically when using the `using` keyword.
   */
  [Symbol.dispose]() {
    this.#conversation.off("prompt_send", this.#on_prompt_send);
    this.#conversation.off("checkpoint_begin", this.#on_checkpoint_begin);
    this.#conversation.off("dispose", this.#on_conversation_dispose);

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
   * @returns This workflow manager instance for chaining.
   */
  once<E extends keyof WorkflowManagerEvents>(
    event: E,
    listener: E extends keyof WorkflowManagerEvents
      ? (...args: WorkflowManagerEvents[E]) => void
      : never,
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
   * @returns This workflow manager instance for chaining.
   */
  on<E extends keyof WorkflowManagerEvents>(
    event: E,
    listener: E extends keyof WorkflowManagerEvents
      ? (...args: WorkflowManagerEvents[E]) => void
      : never,
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
   * @returns This workflow manager instance for chaining.
   */
  off<E extends keyof WorkflowManagerEvents>(
    event: E,
    listener: E extends keyof WorkflowManagerEvents
      ? (...args: WorkflowManagerEvents[E]) => void
      : never,
  ): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.#event_emitter as any).off(event, listener);
    return this;
  }

  /**
   * Manually starts a workflow.
   *
   * This is typically not needed as workflows are started automatically when messages are sent.
   */
  start_workflow() {
    if (this.#state !== "idle") {
      throw new Error("invalid state");
    }
  }

  #on_prompt_send = ({ message }: PromptRequestData) => {
    if (this.#current_workflow) {
      return;
    }
    this.#current_workflow = new Workflow(this.#conversation, { context_data: this.#context_data });

    this.#attach_workflow_event(this.#current_workflow, "state_change");
    this.#attach_workflow_event(this.#current_workflow, "workflow_update");
    this.#attach_workflow_event(this.#current_workflow, "workflow_end");
    this.#attach_workflow_event(this.#current_workflow, "child_workflow_begin");
    this.#attach_workflow_event(this.#current_workflow, "child_workflow_event");
    this.#attach_workflow_event(this.#current_workflow, "message_queued");
    this.#attach_workflow_event(this.#current_workflow, "message_dequeued");
    this.#attach_workflow_event(this.#current_workflow, "queue_cleared");
    this.#attach_workflow_event(this.#current_workflow, "lifecycle_error");
    this.#attach_workflow_event(this.#current_workflow, "dispose");

    this.#current_workflow.once("dispose", () => {
      this.#current_workflow = undefined;
      this.#set_state("idle");
    });

    this.#set_state("busy");
    this.#event_emitter.emit("workflow_begin", this.#current_workflow, this);

    this.#current_workflow.start(message);
  };

  #set_state(state: WorkflowState) {
    if (this.#state === state) {
      return;
    }
    const previous = this.state;

    this.#state = state;
    this.#event_emitter.emit("state_change", { previous, current: this.#state }, this);
  }

  #attach_workflow_event(workflow: Workflow, event_name: keyof WorkflowEvents) {
    const handler = (...args: unknown[]) => {
      this.#event_emitter.emit(
        "workflow_event",
        {
          event_name,
          event_args: args,
        } as WorkflowManagerEvents["workflow_event"][0],
        this,
      );
    };
    workflow.on(event_name, handler);
    workflow.once("dispose", () => setImmediate(() => workflow.off(event_name, handler)));
  }

  #on_checkpoint_begin = (child: Conversation) => {
    this.#set_state("busy");
    child.once("dispose", () => {
      this.#set_state("idle");
    });
  };

  #on_conversation_dispose = () => this[Symbol.dispose]();
}
