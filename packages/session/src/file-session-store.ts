import fs from "node:fs/promises";
import path from "node:path";
import type { Message } from "@simulacra-ai/core";
import type { SessionMetadata, SessionStore } from "./types.ts";

interface SessionFile {
  metadata: Omit<SessionMetadata, "id">;
  messages: Message[];
}

/**
 * `"json"` (default): one file per session containing both metadata and messages.
 * Rewritten in full on every save.
 *
 * `"ndjson"`: two files per session — `<id>.meta.json` (metadata, rewritten)
 * and `<id>.ndjson` (one message per line, appended to). Append is detected
 * via an in-memory message count cache; saves with shorter-or-equal length
 * fall back to a full rewrite. Metadata is small enough that rewriting it
 * every save is cheap.
 */
export type FileSessionFormat = "json" | "ndjson";

export interface FileSessionStoreOptions {
  format?: FileSessionFormat;
}

/**
 * A file-based implementation of SessionStore. Supports a `json` mode
 * (single file per session) and an `ndjson` mode (append-friendly messages
 * file with a sidecar metadata file).
 */
export class FileSessionStore implements SessionStore {
  readonly #root: string;
  readonly #format: FileSessionFormat;
  /** Per-session count of messages already written to disk (ndjson mode only). */
  readonly #written = new Map<string, number>();

  constructor(root: string, options: FileSessionStoreOptions = {}) {
    this.#root = root;
    this.#format = options.format ?? "json";
  }

  async list(): Promise<SessionMetadata[]> {
    await this.#ensure_dir();
    const sessions = new Map<string, SessionMetadata>();
    const entries = await fs.readdir(this.#root, { withFileTypes: true });

    // Autodetect: pick up both formats. ndjson `<id>.meta.json` wins over
    // a same-id `<id>.json` if both exist (migration in progress).
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name.endsWith(".meta.json")) {
        const id = entry.name.replace(/\.meta\.json$/, "");
        const meta = await this.#read_meta_file(id);
        if (meta) {
          sessions.set(id, meta);
        }
      } else if (entry.name.endsWith(".json")) {
        const id = entry.name.replace(/\.json$/, "");
        if (sessions.has(id)) {
          continue;
        }
        const meta = await this.#read_json_metadata(path.join(this.#root, entry.name), id);
        if (meta) {
          sessions.set(id, meta);
        }
      }
    }

    return [...sessions.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /**
   * Reads always autodetect: tries ndjson first (presence of `<id>.meta.json`),
   * then falls back to the `<id>.json` single-file format. Lets a store
   * configured for one format still read sessions previously written in the other.
   */
  async load(id: string) {
    const ndjson = await this.#read_ndjson_session(id);
    if (ndjson) {
      return ndjson;
    }
    return this.#read_json_session(id);
  }

  async save(id: string, messages: Message[], metadata?: Partial<SessionMetadata>) {
    const now = new Date().toISOString();
    await this.#ensure_dir();

    const existing = await this.load(id);
    const existing_metadata: Partial<SessionMetadata> = existing?.metadata ?? {};
    const parent_id = metadata?.parent_id ?? existing_metadata.parent_id;

    const merged_meta: Omit<SessionMetadata, "id"> = {
      ...existing_metadata,
      created_at: existing_metadata.created_at ?? now,
      updated_at: now,
      message_count: messages.length,
      ...metadata,
    };

    if (this.#format === "json") {
      const file: SessionFile = { metadata: merged_meta, messages };
      const file_path = path.join(this.#root, `${id}.json`);
      await fs.writeFile(file_path, JSON.stringify(file, null, 2), "utf8");
    } else {
      await this.#save_ndjson(id, merged_meta, messages);
    }

    if (parent_id) {
      await this.#ensure_fork_link(parent_id, id);
    }
  }

  async delete(id: string) {
    const existing = await this.load(id);
    if (!existing) {
      return false;
    }

    // Delete files in both formats so a store configured for one format
    // can still clean up a session previously written in the other.
    let deleted = false;
    for (const candidate of [`${id}.json`, `${id}.meta.json`, `${id}.ndjson`]) {
      try {
        await fs.unlink(path.join(this.#root, candidate));
        deleted = true;
      } catch {
        /* not present */
      }
    }
    this.#written.delete(id);
    if (!deleted) {
      return false;
    }

    if (existing.metadata.parent_id) {
      // Try both fork-link extensions; only one will exist.
      for (const ext of [".json", ".ndjson"]) {
        const link = path.join(this.#root, `${existing.metadata.parent_id}-forks`, `${id}${ext}`);
        try {
          await fs.unlink(link);
        } catch {
          /* not present */
        }
      }
    }

    const fork_dir = path.join(this.#root, `${id}-forks`);
    try {
      await fs.rm(fork_dir, { recursive: true });
    } catch {
      /* no forks */
    }

    return true;
  }

  async #save_ndjson(id: string, metadata: Omit<SessionMetadata, "id">, messages: Message[]) {
    const meta_path = path.join(this.#root, `${id}.meta.json`);
    const data_path = path.join(this.#root, `${id}.ndjson`);

    await fs.writeFile(meta_path, JSON.stringify(metadata, null, 2), "utf8");

    const cached = this.#written.get(id);
    if (cached !== undefined && messages.length > cached) {
      // Append-only fast path: only the new messages get written.
      const lines = messages
        .slice(cached)
        .map((m) => JSON.stringify(m))
        .join("\n");
      await fs.appendFile(data_path, lines + "\n", "utf8");
    } else {
      // Full rewrite: first write, or messages array shrunk / replaced.
      const body = messages.map((m) => JSON.stringify(m)).join("\n");
      await fs.writeFile(data_path, body.length > 0 ? body + "\n" : "", "utf8");
    }
    this.#written.set(id, messages.length);
  }

  async #read_json_session(id: string) {
    try {
      const file_path = path.join(this.#root, `${id}.json`);
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

  async #read_json_metadata(file_path: string, id: string): Promise<SessionMetadata | undefined> {
    try {
      const content = await fs.readFile(file_path, "utf8");
      const data: SessionFile = JSON.parse(content);
      return { id, ...data.metadata };
    } catch {
      return undefined;
    }
  }

  async #read_ndjson_session(id: string) {
    const meta = await this.#read_meta_file(id);
    if (!meta) {
      return undefined;
    }
    const data_path = path.join(this.#root, `${id}.ndjson`);
    let messages: Message[] = [];
    try {
      const content = await fs.readFile(data_path, "utf8");
      messages = content
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Message);
    } catch {
      /* missing or empty */
    }
    this.#written.set(id, messages.length);
    return { metadata: meta, messages };
  }

  async #read_meta_file(id: string): Promise<SessionMetadata | undefined> {
    try {
      const content = await fs.readFile(path.join(this.#root, `${id}.meta.json`), "utf8");
      const data = JSON.parse(content) as Omit<SessionMetadata, "id">;
      return { id, ...data };
    } catch {
      return undefined;
    }
  }

  async #ensure_fork_link(parent_id: string, fork_id: string) {
    const fork_dir = path.join(this.#root, `${parent_id}-forks`);
    await fs.mkdir(fork_dir, { recursive: true });

    const ext = this.#format === "json" ? ".json" : ".ndjson";
    const canonical = path.join(this.#root, `${fork_id}${ext}`);
    const link = path.join(fork_dir, `${fork_id}${ext}`);

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

  async #ensure_dir() {
    await fs.mkdir(this.#root, { recursive: true });
  }
}
