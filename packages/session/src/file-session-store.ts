import fs from "node:fs/promises";
import path from "node:path";
import type { Message } from "@simulacra-ai/core";
import type { SessionMetadata, SessionStore } from "./types.ts";

interface SessionFile {
  metadata: Omit<SessionMetadata, "id">;
  messages: Message[];
}

/**
 * A file-based implementation of SessionStore.
 *
 * This store persists sessions as JSON files in a specified directory. Each session
 * is stored in a separate file named with its session ID. The store also maintains
 * hard links for fork relationships to enable efficient querying of session trees.
 */
export class FileSessionStore implements SessionStore {
  readonly #root: string;

  /**
   * Creates a new FileSessionStore instance.
   *
   * @param root - The absolute path to the directory where session files will be stored.
   */
  constructor(root: string) {
    this.#root = root;
  }

  /**
   * Lists all sessions stored in the file system.
   *
   * Reads all JSON files from the root directory and parses their metadata.
   *
   * @returns A promise that resolves to an array of session metadata, sorted by most recently updated first.
   */
  async list(): Promise<SessionMetadata[]> {
    await this.#ensure_dir();
    const sessions: SessionMetadata[] = [];

    const entries = await fs.readdir(this.#root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const session = await this.#read_session(
        path.join(this.#root, entry.name),
        entry.name.replace(/\.json$/, ""),
      );
      if (session) {
        sessions.push(session);
      }
    }

    return sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /**
   * Loads a session from the file system.
   *
   * @param id - The unique identifier of the session to load.
   * @returns A promise that resolves to the session metadata and messages, or undefined if not found.
   */
  async load(id: string) {
    return this.#read_file(path.join(this.#root, `${id}.json`), id);
  }

  /**
   * Saves a session to the file system.
   *
   * Creates a new session file if the ID does not exist, or updates an existing file.
   * Automatically updates the updated_at timestamp and message_count. If the session
   * has a parent, creates a hard link in the parent's fork directory for efficient querying.
   *
   * @param id - The unique identifier of the session.
   * @param messages - The messages to store for this session.
   * @param metadata - Optional partial metadata to merge with existing metadata.
   * @returns A promise that resolves when the save operation is complete.
   */
  async save(id: string, messages: Message[], metadata?: Partial<SessionMetadata>) {
    const now = new Date().toISOString();
    await this.#ensure_dir();

    const file_path = path.join(this.#root, `${id}.json`);
    const existing = await this.#read_file(file_path, id);
    const existing_metadata: Partial<SessionMetadata> = existing?.metadata ?? {};
    const parent_id = metadata?.parent_id ?? existing_metadata.parent_id;

    const file: SessionFile = {
      metadata: {
        ...existing_metadata,
        created_at: existing_metadata.created_at ?? now,
        updated_at: now,
        message_count: messages.length,
        ...metadata,
      },
      messages,
    };

    await fs.writeFile(file_path, JSON.stringify(file, null, 2), "utf8");

    if (parent_id) {
      await this.#ensure_fork_link(parent_id, id);
    }
  }

  /**
   * Deletes a session from the file system.
   *
   * Removes the session file, any hard links in parent fork directories, and the session's
   * own fork directory if it exists.
   *
   * @param id - The unique identifier of the session to delete.
   * @returns A promise that resolves to true if the session was deleted, false if it was not found.
   */
  async delete(id: string) {
    const file_path = path.join(this.#root, `${id}.json`);
    try {
      const result = await this.#read_file(file_path, id);
      await fs.unlink(file_path);

      if (result?.metadata.parent_id) {
        const link = path.join(this.#root, `${result.metadata.parent_id}-forks`, `${id}.json`);
        try {
          await fs.unlink(link);
        } catch {
          /* link may not exist */
        }
      }

      const fork_dir = path.join(this.#root, `${id}-forks`);
      try {
        await fs.rm(fork_dir, { recursive: true });
      } catch {
        /* no forks */
      }

      return true;
    } catch {
      return false;
    }
  }

  async #ensure_fork_link(parent_id: string, fork_id: string) {
    const fork_dir = path.join(this.#root, `${parent_id}-forks`);
    await fs.mkdir(fork_dir, { recursive: true });

    const canonical = path.join(this.#root, `${fork_id}.json`);
    const link = path.join(fork_dir, `${fork_id}.json`);

    try {
      await fs.unlink(link);
    } catch {
      /* doesn't exist yet */
    }

    try {
      await fs.link(canonical, link);
    } catch {
      // hard links can fail across filesystems — fall back to no index
    }
  }

  async #read_file(file_path: string, id: string) {
    try {
      const content = await fs.readFile(file_path, "utf8");
      const data: SessionFile = JSON.parse(content);
      return {
        metadata: { id, ...data.metadata } as SessionMetadata,
        messages: data.messages,
      };
    } catch {
      return undefined;
    }
  }

  async #read_session(file_path: string, id: string): Promise<SessionMetadata | undefined> {
    try {
      const content = await fs.readFile(file_path, "utf8");
      const data: SessionFile = JSON.parse(content);
      return { id, ...data.metadata };
    } catch {
      return undefined;
    }
  }

  async #ensure_dir() {
    await fs.mkdir(this.#root, { recursive: true });
  }
}
