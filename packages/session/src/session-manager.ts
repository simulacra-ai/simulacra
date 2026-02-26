import { randomUUID } from "node:crypto";
import EventEmitter from "node:events";
import type { Conversation, Message } from "@simulacra-ai/core";
import type {
  SessionMetadata,
  SessionStore,
  SessionManagerOptions,
  SessionManagerEvents,
} from "./types.ts";

/**
 * Manages conversation sessions including creation, loading, saving, and forking.
 *
 * The SessionManager acts as a bridge between a Conversation instance and a SessionStore,
 * handling session lifecycle, automatic saving, and session tree management through forking.
 * It supports disposable resource management and event emission for session operations.
 */
export class SessionManager {
  readonly #store: SessionStore;
  readonly #conversation: Conversation;
  readonly #auto_save: boolean;
  readonly #auto_slug: boolean;
  readonly #event_emitter = new EventEmitter<SessionManagerEvents>();
  readonly #child_sessions: SessionManager[] = [];

  #session_id?: string;
  #fork_offset = 0;
  #has_label = false;
  #disposed = false;

  /**
   * Creates a new SessionManager instance.
   *
   * @param store - The storage backend to use for persisting sessions.
   * @param conversation - The conversation instance to manage.
   * @param options - Optional configuration for session management behavior.
   */
  constructor(store: SessionStore, conversation: Conversation, options?: SessionManagerOptions) {
    this.#store = store;
    this.#conversation = conversation;
    this.#auto_save = options?.auto_save ?? true;
    this.#auto_slug = options?.auto_slug ?? true;

    if (this.#auto_save) {
      this.#conversation.on("message_complete", this.#on_message_complete);
    }
    this.#conversation.on("create_child", this.#on_create_child);
    this.#conversation.once("dispose", this.#on_conversation_dispose);
  }

  /**
   * The ID of the currently active session.
   *
   * @returns The session ID if a session is active, otherwise undefined.
   */
  get current_session_id() {
    return this.#session_id;
  }

  /**
   * Whether a session is currently loaded.
   *
   * @returns True if a session is active, false otherwise.
   */
  get is_loaded() {
    return !!this.#session_id;
  }

  /**
   * Disposes of the SessionManager and cleans up resources.
   *
   * This method removes event listeners, disposes child sessions, and emits the dispose event.
   * It is called automatically when the associated conversation is disposed or when using
   * explicit resource management.
   */
  [Symbol.dispose]() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    for (const child of this.#child_sessions) {
      child[Symbol.dispose]();
    }
    this.#child_sessions.length = 0;

    this.#conversation.off("message_complete", this.#on_message_complete);
    this.#conversation.off("create_child", this.#on_create_child);
    this.#conversation.off("dispose", this.#on_conversation_dispose);
    this.#event_emitter.emit("dispose");
    this.#event_emitter.removeAllListeners();
  }

  /**
   * Starts a new session with a freshly generated ID.
   *
   * This method clears the conversation history and creates a new session. If auto_save
   * is enabled or a label is provided, the session is immediately saved to the store.
   *
   * @param label - Optional label to assign to the new session.
   * @returns The generated session ID.
   */
  start_new(label?: string): string {
    this.#session_id = randomUUID();
    this.#fork_offset = 0;
    this.#has_label = !!label;
    if (this.#conversation.messages.length > 0) {
      this.#conversation.clear();
    }
    if (label || this.#auto_save) {
      this.save({ label }).catch((error) => {
        this.#event_emitter.emit("lifecycle_error", {
          error,
          operation: "save",
          context: { session_id: this.#session_id },
        });
      });
    }
    return this.#session_id;
  }

  /**
   * Creates a new session as a fork of an existing parent session.
   *
   * A fork creates a new session that inherits messages from the parent session up to
   * the fork point. If detached, the fork does not inherit any messages from the parent
   * but still maintains a parent reference for organizational purposes.
   *
   * @param parent_session_id - The ID of the session to fork from.
   * @param options - Optional configuration for the fork operation.
   * @param options.detached - Whether to create a detached fork that does not inherit parent messages.
   * @returns A promise that resolves to the generated session ID for the fork.
   */
  async fork(parent_session_id: string, options?: { detached?: boolean }): Promise<string> {
    const detached = options?.detached ?? false;
    this.#session_id = randomUUID();
    this.#has_label = false;
    if (!detached) {
      this.#conversation.clear();
    }

    let fork_message_id: string | undefined;

    if (!detached) {
      const messages = await this.#resolve_messages(parent_session_id);
      if (messages.length > 0) {
        this.#conversation.load(messages);
        this.#fork_offset = messages.length;
        fork_message_id = messages.at(-1)?.id;
      } else {
        this.#fork_offset = 0;
      }
    } else {
      this.#fork_offset = 0;
    }

    const parent_result = await this.#store.load(parent_session_id);
    if (parent_result?.metadata.checkpoint_state) {
      this.#conversation.checkpoint_state = parent_result.metadata.checkpoint_state;
    }

    await this.save({
      parent_id: parent_session_id,
      fork_message_id,
      detached,
    });

    return this.#session_id;
  }

  /**
   * Loads a session by ID or loads the most recent session if no ID is provided.
   *
   * If no session ID is provided and no sessions exist in the store, this method
   * starts a new session automatically. Loading a session resolves its full message
   * history by recursively following parent references.
   *
   * @param id - The ID of the session to load, or undefined to load the most recent session.
   * @returns A promise that resolves when the session is loaded.
   * @throws {Error} If the specified session ID is not found in the store.
   */
  async load(id?: string): Promise<void> {
    if (id) {
      const messages = await this.#resolve_messages(id);
      const result = await this.#store.load(id);
      if (!result) {
        throw new Error(`session not found: ${id}`);
      }
      this.#session_id = id;
      this.#has_label = !!result.metadata.label;
      this.#conversation.clear();
      this.#fork_offset = messages.length - result.messages.length;
      this.#conversation.load(messages);
      this.#conversation.checkpoint_state = result.metadata.checkpoint_state;
      this.#emit_load(messages);
      return;
    }

    const sessions = await this.#store.list();
    if (!sessions.length) {
      this.start_new();
      return;
    }

    const latest = sessions[0];
    return this.load(latest.id);
  }

  /**
   * Saves the current session to the store.
   *
   * This method persists only the messages owned by this session, excluding any messages
   * inherited from parent sessions. If auto_slug is enabled and no label has been set,
   * a label is automatically generated from the first user message.
   *
   * @param metadata - Optional partial metadata to update on the session.
   * @returns A promise that resolves when the save operation is complete.
   * @throws {Error} If no session is currently active.
   */
  async save(
    metadata?: Partial<
      Pick<
        SessionMetadata,
        "label" | "provider" | "model" | "parent_id" | "fork_message_id" | "detached"
      >
    >,
  ) {
    if (!this.#session_id) {
      throw new Error("no active session");
    }
    const all_messages = this.#conversation.messages;
    const owned_messages = [...all_messages].slice(this.#fork_offset);

    if (this.#auto_slug && !metadata?.label && !this.#has_label) {
      const slug = SessionManager.#derive_slug(all_messages);
      if (slug) {
        metadata = { ...metadata, label: slug };
        this.#has_label = true;
      }
    }

    const conversation_metadata: Partial<SessionMetadata> = { ...metadata };
    if (this.#conversation.is_checkpoint) {
      conversation_metadata.is_checkpoint = true;
    }
    const checkpoint_state = this.#conversation.checkpoint_state;
    if (checkpoint_state) {
      conversation_metadata.checkpoint_state = { ...checkpoint_state };
    }

    await this.#store.save(this.#session_id, owned_messages, conversation_metadata);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.#event_emitter as any).emit("save", {
      id: this.#session_id,
      messages: Object.freeze([...all_messages]),
    });
  }

  /**
   * Lists all sessions stored in the store.
   *
   * @returns A promise that resolves to an array of session metadata, typically sorted by last update time.
   */
  async list() {
    return this.#store.list();
  }

  /**
   * Deletes a session from the store.
   *
   * If the deleted session is currently active, the conversation is cleared and the
   * current session is unset.
   *
   * @param id - The ID of the session to delete.
   * @returns A promise that resolves to true if the session was deleted, false if it was not found.
   */
  async delete(id: string) {
    if (id === this.#session_id) {
      this.#session_id = undefined;
      this.#conversation.clear();
    }
    return this.#store.delete(id);
  }

  /**
   * Renames a session by updating its label.
   *
   * @param id - The ID of the session to rename.
   * @param label - The new label to assign to the session.
   * @returns A promise that resolves when the rename operation is complete.
   * @throws {Error} If the specified session ID is not found in the store.
   */
  async rename(id: string, label: string) {
    const result = await this.#store.load(id);
    if (!result) {
      throw new Error(`session not found: ${id}`);
    }
    await this.#store.save(id, result.messages, { label });
    if (id === this.#session_id) {
      this.#has_label = true;
    }
  }

  /**
   * Registers an event listener for the specified event.
   *
   * @param event - The name of the event to listen for.
   * @param listener - The callback function to invoke when the event is emitted.
   * @returns This SessionManager instance for method chaining.
   */
  on<E extends keyof SessionManagerEvents>(
    event: E,
    listener: (...args: SessionManagerEvents[E]) => void,
  ): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.#event_emitter as any).on(event, listener);
    return this;
  }

  /**
   * Removes an event listener for the specified event.
   *
   * @param event - The name of the event to stop listening for.
   * @param listener - The callback function to remove.
   * @returns This SessionManager instance for method chaining.
   */
  off<E extends keyof SessionManagerEvents>(
    event: E,
    listener: (...args: SessionManagerEvents[E]) => void,
  ): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.#event_emitter as any).off(event, listener);
    return this;
  }

  #emit_load(messages: Readonly<Message[]>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.#event_emitter as any).emit("load", {
      id: this.#session_id,
      messages: Object.freeze([...messages]),
    });
  }

  async #resolve_messages(id: string): Promise<Message[]> {
    const result = await this.#store.load(id);
    if (!result) {
      return [];
    }

    const { metadata, messages } = result;

    if (metadata.parent_id && !metadata.detached) {
      const parent_messages = await this.#resolve_messages(metadata.parent_id);
      if (metadata.fork_message_id) {
        const cut = parent_messages.findIndex((m) => m.id === metadata.fork_message_id);
        if (cut >= 0) {
          return [...parent_messages.slice(0, cut + 1), ...messages];
        }
      }
      return [...parent_messages, ...messages];
    }

    return messages;
  }

  static #derive_slug(messages: readonly Readonly<Message>[]): string | undefined {
    const first_user = messages.find((m) => m.role === "user");
    if (!first_user) {
      return undefined;
    }

    const text_content = first_user.content.find((c) => c.type === "text");
    if (!text_content || text_content.type !== "text" || !text_content.text) {
      return undefined;
    }

    const raw = text_content.text.trim();
    if (!raw) {
      return undefined;
    }

    const truncated = raw.slice(0, 60);
    const at_boundary = truncated.replace(/\s+\S*$/, "");
    return (at_boundary || truncated).slice(0, 50);
  }

  #on_create_child = (child: Conversation) => {
    if (!this.#session_id) {
      return;
    }

    const child_session = new SessionManager(this.#store, child, {
      auto_save: this.#auto_save,
      auto_slug: !child.is_checkpoint && this.#auto_slug,
    });
    child_session.fork(this.#session_id, { detached: true }).catch((error) => {
      this.#event_emitter.emit("lifecycle_error", { error, operation: "fork" });
    });
    this.#child_sessions.push(child_session);

    child.once("dispose", () => {
      child_session[Symbol.dispose]();
      const idx = this.#child_sessions.indexOf(child_session);
      if (idx >= 0) {
        this.#child_sessions.splice(idx, 1);
      }
    });
  };

  #on_message_complete = () => {
    if (this.#session_id) {
      this.save().catch((error) => {
        this.#event_emitter.emit("lifecycle_error", {
          error,
          operation: "save",
          context: { session_id: this.#session_id },
        });
      });
    }
  };

  #on_conversation_dispose = () => this[Symbol.dispose]();
}
