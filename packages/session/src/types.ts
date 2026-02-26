import type { CheckpointState, LifecycleErrorEvent, Message } from "@simulacra-ai/core";

/**
 * Metadata that describes a conversation session.
 *
 * Sessions can form a tree structure through forking, where a child session
 * can inherit messages from its parent session up to a specific fork point.
 */
export interface SessionMetadata {
  /** The unique identifier for the session. */
  id: string;
  /** ISO 8601 timestamp when the session was created. */
  created_at: string;
  /** ISO 8601 timestamp when the session was last updated. */
  updated_at: string;
  /** The AI provider used in this session (e.g., "anthropic", "openai"). */
  provider?: string;
  /** The model identifier used in this session (e.g., "claude-3-5-sonnet-20241022"). */
  model?: string;
  /** A human-readable label or title for the session. */
  label?: string;
  /** The number of messages stored in this session. */
  message_count: number;
  /** The ID of the parent session if this is a fork. */
  parent_id?: string;
  /** The ID of the last message from the parent session included in this fork. */
  fork_message_id?: string;
  /** Whether this fork is detached and does not inherit parent messages. */
  detached?: boolean;
  /** Whether this session is a checkpoint summarization session. */
  is_checkpoint?: boolean;
  /** The latest checkpoint state for this conversation. */
  checkpoint_state?: CheckpointState;
}

/**
 * A storage backend for conversation sessions.
 *
 * Implementations are responsible for persisting sessions and their messages,
 * whether in memory, on disk, or in a database.
 */
export interface SessionStore {
  /**
   * Lists all stored sessions.
   *
   * @returns A promise that resolves to an array of session metadata, typically sorted by last update time.
   */
  list(): Promise<SessionMetadata[]>;

  /**
   * Loads a session by its ID.
   *
   * @param id - The unique identifier of the session to load.
   * @returns A promise that resolves to the session metadata and messages, or undefined if not found.
   */
  load(id: string): Promise<{ metadata: SessionMetadata; messages: Message[] } | undefined>;

  /**
   * Saves a session with the given messages and metadata.
   *
   * If the session already exists, it updates the existing entry. If it does not exist, it creates a new one.
   *
   * @param id - The unique identifier of the session.
   * @param messages - The messages to store for this session.
   * @param metadata - Optional partial metadata to merge with existing or create new metadata.
   * @returns A promise that resolves when the save operation is complete.
   */
  save(id: string, messages: Message[], metadata?: Partial<SessionMetadata>): Promise<void>;

  /**
   * Deletes a session by its ID.
   *
   * @param id - The unique identifier of the session to delete.
   * @returns A promise that resolves to true if the session was deleted, false if it was not found.
   */
  delete(id: string): Promise<boolean>;
}

/**
 * Configuration options for SessionManager behavior.
 */
export interface SessionManagerOptions {
  /**
   * Whether to automatically save the session after each completed message.
   *
   * @defaultValue true
   */
  auto_save?: boolean;

  /**
   * Whether to automatically generate a label from the first user message.
   *
   * @defaultValue true
   */
  auto_slug?: boolean;
}

/**
 * Events emitted by SessionManager instances.
 *
 * Each event key maps to a tuple representing the arguments passed to event listeners.
 */
export interface SessionManagerEvents {
  /** Emitted when a session is loaded. */
  load: [{ id: string; messages: Readonly<Message[]> }];
  /** Emitted when a session is saved. */
  save: [{ id: string; messages: Readonly<Message[]> }];
  /** Emitted when an infrastructure or lifecycle operation fails. */
  lifecycle_error: [LifecycleErrorEvent];
  /** Emitted when the SessionManager is disposed. */
  dispose: [];
}
