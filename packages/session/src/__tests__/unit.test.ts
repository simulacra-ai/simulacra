import { describe, expect, it, vi } from "vitest";
import type { Message } from "@simulacra-ai/core";
import {
  DrizzleSessionStore,
  type DrizzleSessionAdapter,
  type DrizzleSessionRow,
} from "../drizzle-session-store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function make_message(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function make_row(id: string, overrides: Partial<DrizzleSessionRow> = {}): DrizzleSessionRow {
  const now = new Date().toISOString();
  return {
    id,
    metadata: {
      created_at: now,
      updated_at: now,
      message_count: 0,
    },
    messages: [],
    updated_at: now,
    ...overrides,
  };
}

function make_adapter(rows: DrizzleSessionRow[] = []): DrizzleSessionAdapter & {
  upserted: DrizzleSessionRow[];
  deleted: string[];
} {
  const store = new Map(rows.map((r) => [r.id, r]));
  const upserted: DrizzleSessionRow[] = [];
  const deleted: string[] = [];

  return {
    upserted,
    deleted,
    list: vi.fn(async () =>
      [...store.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    ),
    load: vi.fn(async (id) => {
      const row = store.get(id);
      return row ? { metadata: row.metadata, messages: row.messages } : undefined;
    }),
    upsert: vi.fn(async (row) => {
      store.set(row.id, row);
      upserted.push(row);
    }),
    delete: vi.fn(async (id) => {
      deleted.push(id);
      return store.delete(id);
    }),
  };
}

// ---------------------------------------------------------------------------
// DrizzleSessionStore – list
// ---------------------------------------------------------------------------

describe("DrizzleSessionStore – list", () => {
  it("returns empty array when no sessions exist", async () => {
    const store = new DrizzleSessionStore(make_adapter());
    expect(await store.list()).toEqual([]);
  });

  it("maps rows to SessionMetadata, attaching the id", async () => {
    const row = make_row("abc", {
      metadata: {
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-02T00:00:00.000Z",
        message_count: 3,
        label: "My session",
      },
    });
    const adapter = make_adapter([row]);
    const store = new DrizzleSessionStore(adapter);

    const sessions = await store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("abc");
    expect(sessions[0].label).toBe("My session");
    expect(sessions[0].message_count).toBe(3);
    expect(sessions[0].created_at).toBe("2024-01-01T00:00:00.000Z");
  });

  it("delegates ordering to the adapter", async () => {
    const older = make_row("old", { updated_at: "2024-01-01T00:00:00.000Z" });
    const newer = make_row("new", { updated_at: "2024-01-03T00:00:00.000Z" });
    const adapter = make_adapter([older, newer]);
    const store = new DrizzleSessionStore(adapter);

    const sessions = await store.list();
    // adapter sorts DESC, so newest first
    expect(sessions[0].id).toBe("new");
    expect(sessions[1].id).toBe("old");
  });
});

// ---------------------------------------------------------------------------
// DrizzleSessionStore – load
// ---------------------------------------------------------------------------

describe("DrizzleSessionStore – load", () => {
  it("returns undefined when session does not exist", async () => {
    const store = new DrizzleSessionStore(make_adapter());
    expect(await store.load("missing")).toBeUndefined();
  });

  it("returns metadata with id attached", async () => {
    const row = make_row("sess-1", {
      metadata: {
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T00:00:00.000Z",
        message_count: 2,
        provider: "anthropic",
        model: "claude-3",
      },
      messages: [make_message("hello"), make_message("world")],
    });
    const store = new DrizzleSessionStore(make_adapter([row]));

    const result = await store.load("sess-1");
    expect(result).toBeDefined();
    expect(result?.metadata.id).toBe("sess-1");
    expect(result?.metadata.provider).toBe("anthropic");
    expect(result?.metadata.model).toBe("claude-3");
    expect(result?.messages).toHaveLength(2);
  });

  it("returns messages as an array", async () => {
    const messages: Message[] = [make_message("first"), make_message("second")];
    const row = make_row("s", { messages });
    const store = new DrizzleSessionStore(make_adapter([row]));

    const result = await store.load("s");
    expect(result?.messages).toEqual(messages);
  });
});

// ---------------------------------------------------------------------------
// DrizzleSessionStore – save (new session)
// ---------------------------------------------------------------------------

describe("DrizzleSessionStore – save (new session)", () => {
  it("calls adapter.upsert with the correct id and messages", async () => {
    const adapter = make_adapter();
    const store = new DrizzleSessionStore(adapter);
    const messages = [make_message("hi")];

    await store.save("new-id", messages);

    expect(adapter.upsert).toHaveBeenCalledOnce();
    const [row] = adapter.upserted;
    expect(row.id).toBe("new-id");
    expect(row.messages).toEqual(messages);
  });

  it("sets message_count to the number of messages", async () => {
    const adapter = make_adapter();
    const store = new DrizzleSessionStore(adapter);

    await store.save("s", [make_message("a"), make_message("b"), make_message("c")]);

    const [row] = adapter.upserted;
    expect((row.metadata as { message_count: number }).message_count).toBe(3);
  });

  it("sets updated_at to a recent ISO timestamp on the row", async () => {
    const adapter = make_adapter();
    const store = new DrizzleSessionStore(adapter);
    const before = new Date().toISOString();

    await store.save("s", []);

    const [row] = adapter.upserted;
    expect(row.updated_at >= before).toBe(true);
  });

  it("merges partial metadata into the saved row", async () => {
    const adapter = make_adapter();
    const store = new DrizzleSessionStore(adapter);

    await store.save("s", [], { provider: "openai", model: "gpt-4o", label: "Test" });

    const [row] = adapter.upserted;
    const meta = row.metadata as { provider: string; model: string; label: string };
    expect(meta.provider).toBe("openai");
    expect(meta.model).toBe("gpt-4o");
    expect(meta.label).toBe("Test");
  });
});

// ---------------------------------------------------------------------------
// DrizzleSessionStore – save (existing session)
// ---------------------------------------------------------------------------

describe("DrizzleSessionStore – save (existing session)", () => {
  it("preserves created_at from the existing row", async () => {
    const original_created = "2023-01-01T00:00:00.000Z";
    const row = make_row("s", {
      metadata: {
        created_at: original_created,
        updated_at: "2023-01-01T00:00:00.000Z",
        message_count: 0,
      },
    });
    const adapter = make_adapter([row]);
    const store = new DrizzleSessionStore(adapter);

    await store.save("s", [make_message("new message")]);

    const [upserted] = adapter.upserted;
    expect((upserted.metadata as { created_at: string }).created_at).toBe(original_created);
  });

  it("updates updated_at to a more recent timestamp", async () => {
    const old_updated = "2023-01-01T00:00:00.000Z";
    const row = make_row("s", {
      metadata: {
        created_at: old_updated,
        updated_at: old_updated,
        message_count: 0,
      },
      updated_at: old_updated,
    });
    const adapter = make_adapter([row]);
    const store = new DrizzleSessionStore(adapter);

    await store.save("s", [make_message("updated")]);

    const [upserted] = adapter.upserted;
    expect(upserted.updated_at > old_updated).toBe(true);
  });

  it("updates message_count to the new messages length", async () => {
    const row = make_row("s", {
      metadata: {
        created_at: "2023-01-01T00:00:00.000Z",
        updated_at: "2023-01-01T00:00:00.000Z",
        message_count: 1,
      },
      messages: [make_message("old")],
    });
    const adapter = make_adapter([row]);
    const store = new DrizzleSessionStore(adapter);

    await store.save("s", [make_message("a"), make_message("b")]);

    const [upserted] = adapter.upserted;
    expect((upserted.metadata as { message_count: number }).message_count).toBe(2);
  });

  it("merges new metadata over existing metadata", async () => {
    const row = make_row("s", {
      metadata: {
        created_at: "2023-01-01T00:00:00.000Z",
        updated_at: "2023-01-01T00:00:00.000Z",
        message_count: 0,
        label: "old label",
        provider: "openai",
      },
    });
    const adapter = make_adapter([row]);
    const store = new DrizzleSessionStore(adapter);

    await store.save("s", [], { label: "new label" });

    const [upserted] = adapter.upserted;
    const meta = upserted.metadata as { label: string; provider: string };
    expect(meta.label).toBe("new label");
    expect(meta.provider).toBe("openai"); // unchanged
  });
});

// ---------------------------------------------------------------------------
// DrizzleSessionStore – delete
// ---------------------------------------------------------------------------

describe("DrizzleSessionStore – delete", () => {
  it("returns true when a session is deleted", async () => {
    const adapter = make_adapter([make_row("to-delete")]);
    const store = new DrizzleSessionStore(adapter);

    const result = await store.delete("to-delete");
    expect(result).toBe(true);
    expect(adapter.deleted).toContain("to-delete");
  });

  it("returns false when no session with that id exists", async () => {
    const adapter = make_adapter();
    const store = new DrizzleSessionStore(adapter);

    const result = await store.delete("ghost");
    expect(result).toBe(false);
  });

  it("delegates to the adapter with the correct id", async () => {
    const adapter = make_adapter([make_row("x")]);
    const store = new DrizzleSessionStore(adapter);

    await store.delete("x");
    expect(adapter.delete).toHaveBeenCalledWith("x");
  });
});

// ---------------------------------------------------------------------------
// InMemorySessionStore
// ---------------------------------------------------------------------------

import { InMemorySessionStore } from "../in-memory-session-store.ts";

describe("InMemorySessionStore", () => {
  it("list returns empty array initially", async () => {
    const store = new InMemorySessionStore();
    expect(await store.list()).toEqual([]);
  });

  it("save and load round-trips messages correctly", async () => {
    const store = new InMemorySessionStore();
    const messages: Message[] = [make_message("hello"), make_message("world")];

    await store.save("s1", messages);
    const result = await store.load("s1");

    expect(result).toBeDefined();
    expect(result?.messages).toEqual(messages);
  });

  it("save updates metadata (timestamps, message_count)", async () => {
    const store = new InMemorySessionStore();
    const before = new Date().toISOString();

    await store.save("s1", [make_message("a"), make_message("b")]);

    const result = await store.load("s1");
    expect(result).toBeDefined();
    expect(result?.metadata.id).toBe("s1");
    expect(result?.metadata.message_count).toBe(2);
    expect((result?.metadata.created_at ?? "") >= before).toBe(true);
    expect((result?.metadata.updated_at ?? "") >= before).toBe(true);
  });

  it("list returns sessions sorted by updated_at descending", async () => {
    const store = new InMemorySessionStore();

    // Use explicit timestamps via metadata to guarantee deterministic ordering
    await store.save("older", [make_message("first")], {
      updated_at: "2024-01-01T00:00:00.000Z",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    await store.save("newer", [make_message("second")], {
      updated_at: "2024-06-01T00:00:00.000Z",
      created_at: "2024-06-01T00:00:00.000Z",
    });

    const sessions = await store.list();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe("newer");
    expect(sessions[1].id).toBe("older");
  });

  it("delete removes session and returns true", async () => {
    const store = new InMemorySessionStore();
    await store.save("s1", [make_message("hi")]);

    const result = await store.delete("s1");
    expect(result).toBe(true);
    expect(await store.load("s1")).toBeUndefined();
  });

  it("delete returns false for unknown id", async () => {
    const store = new InMemorySessionStore();
    const result = await store.delete("nonexistent");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

import { SessionManager } from "../session-manager.ts";
import type { Conversation } from "@simulacra-ai/core";

type EventHandler = (...args: unknown[]) => void;

function make_mock_conversation(messages: Message[] = []) {
  const handlers: Record<string, EventHandler[]> = {};
  return {
    messages,
    state: "idle" as const,
    is_checkpoint: false,
    checkpoint_state: undefined as unknown,
    on: vi.fn((event: string, handler: EventHandler) => {
      (handlers[event] ??= []).push(handler);
    }),
    off: vi.fn((event: string, handler: EventHandler) => {
      const list = handlers[event];
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) {
          list.splice(idx, 1);
        }
      }
    }),
    once: vi.fn((event: string, handler: EventHandler) => {
      (handlers[event] ??= []).push(handler);
    }),
    load: vi.fn((msgs: Message[]) => {
      messages.length = 0;
      messages.push(...msgs);
    }),
    clear: vi.fn(() => {
      messages.length = 0;
    }),
    // helper to trigger events in tests
    _emit: (event: string, ...args: unknown[]) => {
      handlers[event]?.forEach((h) => h(...args));
    },
  };
}

describe("SessionManager", () => {
  it("start_new creates a session and returns an id (string)", async () => {
    const store = new InMemorySessionStore();
    const conv = make_mock_conversation();
    const manager = new SessionManager(store, conv as unknown as Conversation);

    const id = manager.start_new();

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    // Wait for the async save triggered internally
    await vi.waitFor(async () => {
      const sessions = await store.list();
      expect(sessions.length).toBe(1);
    });
  });

  it("start_new with label stores the label in metadata", async () => {
    const store = new InMemorySessionStore();
    const conv = make_mock_conversation();
    const manager = new SessionManager(store, conv as unknown as Conversation);

    const id = manager.start_new("My Label");

    await vi.waitFor(async () => {
      const result = await store.load(id);
      expect(result).toBeDefined();
      expect(result?.metadata.label).toBe("My Label");
    });
  });

  it("load restores messages to conversation (calls conversation.load)", async () => {
    const store = new InMemorySessionStore();
    const messages: Message[] = [make_message("restored message")];
    await store.save("existing-id", messages);

    const conv = make_mock_conversation();
    const manager = new SessionManager(store, conv as unknown as Conversation, {
      auto_save: false,
    });

    await manager.load("existing-id");

    expect(conv.load).toHaveBeenCalled();
    expect(conv.messages).toEqual(messages);
  });

  it("save persists current conversation messages to store", async () => {
    const store = new InMemorySessionStore();
    const conv = make_mock_conversation();
    const manager = new SessionManager(store, conv as unknown as Conversation, {
      auto_save: false,
      auto_slug: false,
    });

    const id = manager.start_new();
    // Add message AFTER start_new() so clear() does not wipe it
    conv.messages.push(make_message("persisted"));
    await manager.save();

    const result = await store.load(id);
    expect(result).toBeDefined();
    expect(result?.messages).toEqual([make_message("persisted")]);
  });

  it("auto_save triggers save on message_complete event", async () => {
    const store = new InMemorySessionStore();
    const conv = make_mock_conversation();
    const manager = new SessionManager(store, conv as unknown as Conversation, {
      auto_save: true,
      auto_slug: false,
    });

    const id = manager.start_new();
    // Add message AFTER start_new() so clear() does not wipe it
    conv.messages.push(make_message("auto-saved content"));

    // Simulate a message_complete event
    conv._emit("message_complete");

    await vi.waitFor(async () => {
      const result = await store.load(id);
      expect(result).toBeDefined();
      expect(result?.messages).toEqual([make_message("auto-saved content")]);
    });
  });

  it("auto_slug derives label from first user message (first ~50 chars, trimmed to word boundary)", async () => {
    const store = new InMemorySessionStore();
    const long_text =
      "This is a fairly long message that should be truncated at a word boundary somewhere around fifty characters or so";
    const conv = make_mock_conversation();
    const manager = new SessionManager(store, conv as unknown as Conversation, {
      auto_save: false,
      auto_slug: true,
    });

    const id = manager.start_new();
    // Add the user message after start_new, which clears the conversation
    conv.messages.push(make_message(long_text));
    await manager.save();

    const result = await store.load(id);
    expect(result).toBeDefined();
    const label = result?.metadata.label;
    expect(label).toBeDefined();
    expect((label as string).length).toBeLessThanOrEqual(60);
    // It should be a prefix of the original text
    expect(long_text.startsWith(label as string)).toBe(true);
  });

  it("rename changes session label", async () => {
    const store = new InMemorySessionStore();
    const conv = make_mock_conversation();
    const manager = new SessionManager(store, conv as unknown as Conversation, {
      auto_save: false,
      auto_slug: false,
    });

    const id = manager.start_new();
    await manager.save();
    await manager.rename(id, "Renamed Session");

    const result = await store.load(id);
    expect(result).toBeDefined();
    expect(result?.metadata.label).toBe("Renamed Session");
  });

  it("auto_slug trims to a word boundary near 50 chars", async () => {
    const store = new InMemorySessionStore();
    const raw =
      "Exploring the fundamental principles of quantum mechanics requires deep understanding";
    const conv = make_mock_conversation();
    const manager = new SessionManager(store, conv as unknown as Conversation, {
      auto_save: false,
      auto_slug: true,
    });

    const id = manager.start_new();
    conv.messages.push(make_message(raw));
    await manager.save();

    const result = await store.load(id);
    expect(result).toBeDefined();
    const label = result?.metadata.label as string;
    expect(label.length).toBeLessThanOrEqual(60);

    const nextChar = raw[label.length];
    expect(nextChar === undefined || nextChar === " ").toBe(true);
  });

  it("load throws when session id does not exist", async () => {
    const store = new InMemorySessionStore();
    const conv = make_mock_conversation();
    const manager = new SessionManager(store, conv as unknown as Conversation, {
      auto_save: false,
    });

    await expect(manager.load("nonexistent")).rejects.toThrow("session not found");
  });

  it("save throws when no session is active", async () => {
    const store = new InMemorySessionStore();
    const conv = make_mock_conversation();
    const manager = new SessionManager(store, conv as unknown as Conversation, {
      auto_save: false,
    });

    await expect(manager.save()).rejects.toThrow("no active session");
  });

  it("delete removes session from store", async () => {
    const store = new InMemorySessionStore();
    const conv = make_mock_conversation();
    const manager = new SessionManager(store, conv as unknown as Conversation, {
      auto_save: false,
    });

    const id = manager.start_new();
    await manager.save();

    const deleted = await manager.delete(id);
    expect(deleted).toBe(true);
    expect(await store.load(id)).toBeUndefined();
  });
});
