import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@simulacra-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../file-session-store.ts";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fss-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function user_msg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("FileSessionStore json format (default)", () => {
  it("writes a single .json file and round-trips", async () => {
    const store = new FileSessionStore(dir);
    await store.save("s1", [user_msg("hi")]);
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(["s1.json"]);

    const loaded = await store.load("s1");
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.metadata.message_count).toBe(1);
  });
});

describe("FileSessionStore ndjson format", () => {
  it("writes <id>.ndjson + <id>.meta.json and round-trips", async () => {
    const store = new FileSessionStore(dir, { format: "ndjson" });
    await store.save("s1", [user_msg("a"), user_msg("b")]);

    const entries = (await fs.readdir(dir)).sort();
    expect(entries).toEqual(["s1.meta.json", "s1.ndjson"]);

    const ndjson = await fs.readFile(path.join(dir, "s1.ndjson"), "utf8");
    expect(ndjson.split("\n").filter(Boolean)).toHaveLength(2);

    const loaded = await store.load("s1");
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.metadata.message_count).toBe(2);
  });

  it("appends new messages instead of rewriting the file", async () => {
    const store = new FileSessionStore(dir, { format: "ndjson" });
    await store.save("s1", [user_msg("a")]);
    const data_path = path.join(dir, "s1.ndjson");
    const after_first = await fs.readFile(data_path, "utf8");

    await store.save("s1", [user_msg("a"), user_msg("b")]);
    const after_second = await fs.readFile(data_path, "utf8");

    // The first line is byte-identical (proving append, not rewrite).
    expect(after_second.startsWith(after_first)).toBe(true);
    expect(after_second.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("falls back to full rewrite when message count shrinks", async () => {
    const store = new FileSessionStore(dir, { format: "ndjson" });
    await store.save("s1", [user_msg("a"), user_msg("b"), user_msg("c")]);
    await store.save("s1", [user_msg("only")]);

    const loaded = await store.load("s1");
    expect(loaded?.messages).toHaveLength(1);
    expect((loaded?.messages[0].content[0] as { text: string }).text).toBe("only");
  });

  it("appends across separate store instances when prior state is loaded first", async () => {
    const a = new FileSessionStore(dir, { format: "ndjson" });
    await a.save("s1", [user_msg("a")]);

    // New instance: priming via load() populates the per-session count cache.
    const b = new FileSessionStore(dir, { format: "ndjson" });
    await b.load("s1");
    const before = await fs.readFile(path.join(dir, "s1.ndjson"), "utf8");

    await b.save("s1", [user_msg("a"), user_msg("b")]);
    const after = await fs.readFile(path.join(dir, "s1.ndjson"), "utf8");
    expect(after.startsWith(before)).toBe(true);
  });
});

describe("FileSessionStore autodetect on read", () => {
  it("loads ndjson sessions even when configured for json", async () => {
    const ndjson_store = new FileSessionStore(dir, { format: "ndjson" });
    await ndjson_store.save("s1", [user_msg("written as ndjson")]);

    const json_store = new FileSessionStore(dir);
    const loaded = await json_store.load("s1");
    expect(loaded?.messages).toHaveLength(1);
  });

  it("loads json sessions even when configured for ndjson", async () => {
    const json_store = new FileSessionStore(dir);
    await json_store.save("s1", [user_msg("written as json")]);

    const ndjson_store = new FileSessionStore(dir, { format: "ndjson" });
    const loaded = await ndjson_store.load("s1");
    expect(loaded?.messages).toHaveLength(1);
  });

  it("list() picks up sessions in both formats", async () => {
    const json_store = new FileSessionStore(dir);
    await json_store.save("a", [user_msg("a")]);
    const ndjson_store = new FileSessionStore(dir, { format: "ndjson" });
    await ndjson_store.save("b", [user_msg("b")]);

    const ids = (await json_store.list()).map((s) => s.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("FileSessionStore delete", () => {
  it("removes ndjson session files", async () => {
    const store = new FileSessionStore(dir, { format: "ndjson" });
    await store.save("s1", [user_msg("hi")]);
    expect(await store.delete("s1")).toBe(true);
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.startsWith("s1"))).toEqual([]);
  });

  it("returns false for an unknown session", async () => {
    const store = new FileSessionStore(dir);
    expect(await store.delete("missing")).toBe(false);
  });
});
