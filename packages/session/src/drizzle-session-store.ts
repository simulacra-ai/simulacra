import type { Message } from "@simulacra-ai/core";
import type { SessionMetadata, SessionStore } from "./types.ts";

/**
 * The shape of a row in the sessions table.
 *
 * Use this as a reference when defining your drizzle table schema. The `metadata`
 * and `messages` columns should be JSON/JSONB columns (or text with JSON mode in SQLite).
 *
 * Example drizzle schema (PostgreSQL):
 * ```ts
 * import { pgTable, text, jsonb } from "drizzle-orm/pg-core";
 *
 * export const sessionsTable = pgTable("sessions", {
 *   id:         text("id").primaryKey(),
 *   metadata:   jsonb("metadata").notNull(),
 *   messages:   jsonb("messages").notNull(),
 *   updated_at: text("updated_at").notNull(),
 * });
 * ```
 *
 * Example drizzle schema (SQLite):
 * ```ts
 * import { sqliteTable, text } from "drizzle-orm/sqlite-core";
 *
 * export const sessionsTable = sqliteTable("sessions", {
 *   id:         text("id").primaryKey(),
 *   metadata:   text("metadata", { mode: "json" }).notNull(),
 *   messages:   text("messages", { mode: "json" }).notNull(),
 *   updated_at: text("updated_at").notNull(),
 * });
 * ```
 */
export type DrizzleSessionRow = {
  id: string;
  /** JSON-serializable value storing `Omit<SessionMetadata, "id">`. */
  metadata: unknown;
  /** JSON-serializable value storing `Message[]`. */
  messages: unknown;
  /** ISO 8601 timestamp — denormalized from metadata for efficient ORDER BY. */
  updated_at: string;
}

/**
 * Adapter interface that bridges `DrizzleSessionStore` with a drizzle database instance.
 *
 * Implement this interface using your own drizzle `db` and table, then pass it to
 * `DrizzleSessionStore`. This keeps drizzle out of the session package's dependencies.
 *
 * @example
 * ```ts
 * import { eq, desc } from "drizzle-orm";
 * import { DrizzleSessionStore, type DrizzleSessionAdapter } from "@simulacra-ai/session";
 *
 * const adapter: DrizzleSessionAdapter = {
 *   list: () =>
 *     db.select().from(sessionsTable).orderBy(desc(sessionsTable.updated_at)),
 *
 *   load: async (id) => {
 *     const [row] = await db
 *       .select({ metadata: sessionsTable.metadata, messages: sessionsTable.messages })
 *       .from(sessionsTable)
 *       .where(eq(sessionsTable.id, id));
 *     return row;
 *   },
 *
 *   upsert: (row) =>
 *     db
 *       .insert(sessionsTable)
 *       .values(row)
 *       .onConflictDoUpdate({
 *         target: sessionsTable.id,
 *         set: { metadata: row.metadata, messages: row.messages, updated_at: row.updated_at },
 *       }),
 *
 *   delete: async (id) => {
 *     const result = await db.delete(sessionsTable).where(eq(sessionsTable.id, id));
 *     return result.rowCount > 0;
 *   },
 * };
 *
 * const store = new DrizzleSessionStore(adapter);
 * ```
 */
export type DrizzleSessionAdapter = {
  /**
   * Returns all session rows, sorted by `updated_at` descending (most recent first).
   */
  list(): Promise<DrizzleSessionRow[]>;

  /**
   * Returns the metadata and messages for a single session, or undefined if not found.
   *
   * Only `metadata` and `messages` are required in the return value.
   */
  load(id: string): Promise<Pick<DrizzleSessionRow, "metadata" | "messages"> | undefined>;

  /**
   * Inserts or updates a session row. On conflict with an existing `id`, the
   * metadata, messages, and updated_at columns should be updated.
   */
  upsert(row: DrizzleSessionRow): Promise<void>;

  /**
   * Deletes a session by id.
   *
   * @returns `true` if a row was deleted, `false` if no row with that id existed.
   */
  delete(id: string): Promise<boolean>;
}

/**
 * A database-backed implementation of `SessionStore` powered by drizzle ORM.
 *
 * Rather than importing drizzle directly, this store accepts a {@link DrizzleSessionAdapter}
 * that you implement using your own drizzle instance and table. This keeps drizzle out of
 * this package's dependencies while still providing full session persistence.
 *
 * See {@link DrizzleSessionAdapter} for an implementation example and
 * {@link DrizzleSessionRow} for the expected table schema.
 */
export class DrizzleSessionStore implements SessionStore {
  readonly #adapter: DrizzleSessionAdapter;

  constructor(adapter: DrizzleSessionAdapter) {
    this.#adapter = adapter;
  }

  /**
   * Lists all sessions, sorted by most recently updated first.
   *
   * @returns A promise that resolves to an array of session metadata.
   */
  async list(): Promise<SessionMetadata[]> {
    const rows = await this.#adapter.list();
    return rows.map((row) => ({
      id: row.id,
      ...(row.metadata as Omit<SessionMetadata, "id">),
    }));
  }

  /**
   * Loads a session by its ID.
   *
   * @param id - The unique identifier of the session to load.
   * @returns A promise that resolves to the session metadata and messages, or undefined if not found.
   */
  async load(id: string): Promise<{ metadata: SessionMetadata; messages: Message[] } | undefined> {
    const row = await this.#adapter.load(id);
    if (!row) {
      return undefined;
    }
    return {
      metadata: {
        id,
        ...(row.metadata as Omit<SessionMetadata, "id">),
      },
      messages: row.messages as Message[],
    };
  }

  /**
   * Saves a session with the given messages and metadata.
   *
   * Creates a new session if the ID does not exist, or updates the existing session.
   * Automatically updates the `updated_at` timestamp and `message_count`.
   *
   * @param id - The unique identifier of the session.
   * @param messages - The messages to store for this session.
   * @param metadata - Optional partial metadata to merge with existing metadata.
   * @returns A promise that resolves when the save operation is complete.
   */
  async save(id: string, messages: Message[], metadata?: Partial<SessionMetadata>): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.#adapter.load(id);
    const existing_metadata = existing?.metadata as Partial<SessionMetadata> | undefined;

    const merged: Omit<SessionMetadata, "id"> = {
      ...existing_metadata,
      created_at: existing_metadata?.created_at ?? now,
      updated_at: now,
      message_count: messages.length,
      ...metadata,
    };

    await this.#adapter.upsert({
      id,
      metadata: merged,
      messages,
      updated_at: now,
    });
  }

  /**
   * Deletes a session by its ID.
   *
   * @param id - The unique identifier of the session to delete.
   * @returns A promise that resolves to true if the session was deleted, false if it was not found.
   */
  async delete(id: string): Promise<boolean> {
    return this.#adapter.delete(id);
  }
}
