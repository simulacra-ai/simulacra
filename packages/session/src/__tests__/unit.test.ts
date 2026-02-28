import { describe, expect, it, vi } from "vitest";
import type { Message } from "@simulacra-ai/core";
import { DrizzleSessionStore, type DrizzleSessionAdapter, type DrizzleSessionRow } from "../drizzle-session-store.ts";

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
    expect(result!.metadata.id).toBe("sess-1");
    expect(result!.metadata.provider).toBe("anthropic");
    expect(result!.metadata.model).toBe("claude-3");
    expect(result!.messages).toHaveLength(2);
  });

  it("returns messages as an array", async () => {
    const messages: Message[] = [make_message("first"), make_message("second")];
    const row = make_row("s", { messages });
    const store = new DrizzleSessionStore(make_adapter([row]));

    const result = await store.load("s");
    expect(result!.messages).toEqual(messages);
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
      metadata: { created_at: "2023-01-01T00:00:00.000Z", updated_at: "2023-01-01T00:00:00.000Z", message_count: 1 },
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
