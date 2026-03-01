/**
 * End-to-end tests for DrizzleSessionStore using an in-memory SQLite database
 * via drizzle-orm + better-sqlite3.
 *
 * These tests verify the full integration: adapter wiring → DrizzleSessionStore
 * → drizzle → SQLite, exercising the real query builder path.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { eq, desc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Message } from "@simulacra-ai/core";
import { DrizzleSessionStore, type DrizzleSessionAdapter } from "../drizzle-session-store.ts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const sessionsTable = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  metadata: text("metadata", { mode: "json" }).notNull(),
  messages: text("messages", { mode: "json" }).notNull(),
  updated_at: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof drizzle>;

function create_adapter(db: Db): DrizzleSessionAdapter {
  return {
    list: () =>
      db.select().from(sessionsTable).orderBy(desc(sessionsTable.updated_at)) as Promise<
        { id: string; metadata: unknown; messages: unknown; updated_at: string }[]
      >,

    load: async (id) => {
      const [row] = await db
        .select({ metadata: sessionsTable.metadata, messages: sessionsTable.messages })
        .from(sessionsTable)
        .where(eq(sessionsTable.id, id));
      return row as { metadata: unknown; messages: unknown } | undefined;
    },

    upsert: async (row) => {
      await db
        .insert(sessionsTable)
        .values(row)
        .onConflictDoUpdate({
          target: sessionsTable.id,
          set: {
            metadata: row.metadata,
            messages: row.messages,
            updated_at: row.updated_at,
          },
        });
    },

    delete: async (id) => {
      const result = await db.delete(sessionsTable).where(eq(sessionsTable.id, id));
      return result.changes > 0;
    },
  };
}

function make_message(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let sqlite: InstanceType<typeof Database>;
let db: Db;
let store: DrizzleSessionStore;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE sessions (
      id         TEXT PRIMARY KEY,
      metadata   TEXT NOT NULL,
      messages   TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db = drizzle(sqlite);
  store = new DrizzleSessionStore(create_adapter(db));
});

afterEach(() => {
  sqlite.close();
});

// ---------------------------------------------------------------------------
// Basic CRUD
// ---------------------------------------------------------------------------

describe("DrizzleSessionStore (SQLite) – basic CRUD", () => {
  it("saves and loads a session", async () => {
    const messages: Message[] = [make_message("Hello"), make_message("World")];
    await store.save("session-1", messages, { label: "My chat", provider: "anthropic" });

    const result = await store.load("session-1");
    expect(result).toBeDefined();
    expect(result?.metadata.id).toBe("session-1");
    expect(result?.metadata.label).toBe("My chat");
    expect(result?.metadata.provider).toBe("anthropic");
    expect(result?.metadata.message_count).toBe(2);
    expect(result?.messages).toEqual(messages);
  });

  it("returns undefined when loading a session that does not exist", async () => {
    const result = await store.load("nonexistent");
    expect(result).toBeUndefined();
  });

  it("updates an existing session on subsequent saves", async () => {
    const messages_v1: Message[] = [make_message("v1")];
    const messages_v2: Message[] = [make_message("v1"), make_message("v2")];

    await store.save("s", messages_v1);
    await store.save("s", messages_v2);

    const result = await store.load("s");
    expect(result?.messages).toEqual(messages_v2);
    expect(result?.metadata.message_count).toBe(2);
  });

  it("deletes an existing session and returns true", async () => {
    await store.save("to-delete", []);
    const deleted = await store.delete("to-delete");

    expect(deleted).toBe(true);
    expect(await store.load("to-delete")).toBeUndefined();
  });

  it("returns false when deleting a session that does not exist", async () => {
    const deleted = await store.delete("ghost");
    expect(deleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Metadata preservation
// ---------------------------------------------------------------------------

describe("DrizzleSessionStore (SQLite) – metadata preservation", () => {
  it("preserves created_at across updates", async () => {
    await store.save("s", [], { label: "first" });
    const first = await store.load("s");
    expect(first).toBeDefined();
    const original_created_at = first?.metadata.created_at as string;

    // Small delay to ensure updated_at differs
    await new Promise((r) => setTimeout(r, 5));

    await store.save("s", [make_message("new message")]);
    const second = await store.load("s");

    expect(second?.metadata.created_at).toBe(original_created_at);
    expect((second?.metadata.updated_at ?? "") > original_created_at).toBe(true);
  });

  it("merges partial metadata without losing existing fields", async () => {
    await store.save("s", [], { provider: "anthropic", model: "claude-3", label: "Initial" });
    await store.save("s", [make_message("hi")], { label: "Updated" });

    const result = await store.load("s");
    expect(result?.metadata.provider).toBe("anthropic");
    expect(result?.metadata.model).toBe("claude-3");
    expect(result?.metadata.label).toBe("Updated");
  });

  it("stores optional fields like parent_id and fork_message_id", async () => {
    await store.save("child", [], {
      parent_id: "parent-session",
      fork_message_id: "msg-42",
      detached: false,
    });

    const result = await store.load("child");
    expect(result?.metadata.parent_id).toBe("parent-session");
    expect(result?.metadata.fork_message_id).toBe("msg-42");
    expect(result?.metadata.detached).toBe(false);
  });

  it("stores checkpoint_state as JSON", async () => {
    const checkpoint = {
      summary: "The user asked about TypeScript generics",
      last_message_id: "msg-10",
    };
    await store.save("s", [], { checkpoint_state: checkpoint as never });

    const result = await store.load("s");
    expect(result?.metadata.checkpoint_state).toEqual(checkpoint);
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe("DrizzleSessionStore (SQLite) – list", () => {
  it("returns an empty array when there are no sessions", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("returns all saved sessions as metadata", async () => {
    await store.save("a", [], { label: "Alpha" });
    await store.save("b", [], { label: "Beta" });

    const sessions = await store.list();
    expect(sessions).toHaveLength(2);
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  it("returns sessions sorted by updated_at descending", async () => {
    await store.save("first", [], { label: "First" });
    await new Promise((r) => setTimeout(r, 5));
    await store.save("second", [], { label: "Second" });
    await new Promise((r) => setTimeout(r, 5));
    await store.save("third", [], { label: "Third" });

    const sessions = await store.list();
    expect(sessions[0].id).toBe("third");
    expect(sessions[1].id).toBe("second");
    expect(sessions[2].id).toBe("first");
  });

  it("respects ordering after an update makes an older session recent", async () => {
    await store.save("a", [], { label: "A" });
    await new Promise((r) => setTimeout(r, 5));
    await store.save("b", [], { label: "B" });
    await new Promise((r) => setTimeout(r, 5));

    // Update "a" — it should now be most recent
    await store.save("a", [make_message("updated")]);

    const sessions = await store.list();
    expect(sessions[0].id).toBe("a");
    expect(sessions[1].id).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// Message integrity
// ---------------------------------------------------------------------------

describe("DrizzleSessionStore (SQLite) – message integrity", () => {
  it("round-trips complex message content correctly", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Run the tool" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Sure" },
          {
            type: "tool",
            tool: "calculator",
            tool_request_id: "req-1",
            params: { a: 1, b: 2 },
          },
        ],
      },
    ];

    await store.save("s", messages);
    const result = await store.load("s");
    expect(result?.messages).toEqual(messages);
  });

  it("stores an empty messages array correctly", async () => {
    await store.save("s", []);
    const result = await store.load("s");
    expect(result?.messages).toEqual([]);
    expect(result?.metadata.message_count).toBe(0);
  });
});
