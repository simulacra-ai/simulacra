import type { Message } from "@simulacra-ai/core";
import type { SessionMetadata, SessionStore } from "./types.ts";

/**
 * An in-memory implementation of SessionStore.
 *
 * This store keeps all session data in memory using a Map. Data is not persisted
 * across process restarts. Useful for testing or scenarios where persistence is not required.
 */
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, { metadata: SessionMetadata; messages: Message[] }>();

  /**
   * Lists all sessions stored in memory.
   *
   * @returns A promise that resolves to an array of session metadata, sorted by most recently updated first.
   */
  async list(): Promise<SessionMetadata[]> {
    return [...this.#sessions.values()]
      .map((s) => s.metadata)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /**
   * Loads a session from memory.
   *
   * Returns a deep clone of the stored data to prevent external mutations.
   *
   * @param id - The unique identifier of the session to load.
   * @returns A promise that resolves to the session metadata and messages, or undefined if not found.
   */
  async load(id: string) {
    const entry = this.#sessions.get(id);
    if (!entry) {
      return undefined;
    }
    return {
      metadata: { ...entry.metadata },
      messages: structuredClone(entry.messages),
    };
  }

  /**
   * Saves a session to memory.
   *
   * Creates a new session if the ID does not exist, or updates an existing session.
   * Automatically updates the updated_at timestamp and message_count.
   *
   * @param id - The unique identifier of the session.
   * @param messages - The messages to store for this session.
   * @param metadata - Optional partial metadata to merge with existing metadata.
   * @returns A promise that resolves when the save operation is complete.
   */
  async save(id: string, messages: Message[], metadata?: Partial<SessionMetadata>) {
    const now = new Date().toISOString();
    const existing = this.#sessions.get(id);

    this.#sessions.set(id, {
      metadata: {
        id,
        ...existing?.metadata,
        created_at: existing?.metadata.created_at ?? now,
        updated_at: now,
        message_count: messages.length,
        ...metadata,
      },
      messages: structuredClone(messages),
    });
  }

  /**
   * Deletes a session from memory.
   *
   * @param id - The unique identifier of the session to delete.
   * @returns A promise that resolves to true if the session was deleted, false if it was not found.
   */
  async delete(id: string) {
    return this.#sessions.delete(id);
  }
}
