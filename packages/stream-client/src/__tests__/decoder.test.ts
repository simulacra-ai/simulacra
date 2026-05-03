import { describe, expect, it } from "vitest";
import { collect_ndjson, decode_ndjson } from "../decoder.ts";

function string_to_stream(s: string, chunk_sizes?: number[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder().encode(s);
  const sizes = chunk_sizes ?? [enc.length];
  let cursor = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor >= enc.length) {
        controller.close();
        return;
      }
      const next = sizes.shift() ?? enc.length - cursor;
      const slice = enc.slice(cursor, cursor + next);
      cursor += next;
      controller.enqueue(slice);
      if (cursor >= enc.length) {
        controller.close();
      }
    },
  });
}

describe("decode_ndjson", () => {
  it("decodes a complete stream", async () => {
    const wire =
      '{"type":"content_update","data":{"x":1}}\n{"type":"message_complete","data":{}}\n';
    const events = await collect_ndjson(string_to_stream(wire));
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe("message_complete");
  });

  it("buffers partial lines split across chunks", async () => {
    const wire =
      '{"type":"content_update","data":{"x":1}}\n{"type":"message_complete","data":{"y":2}}\n';
    const events = await collect_ndjson(string_to_stream(wire, [3, 5, 12, 4, 100]));
    expect(events).toHaveLength(2);
    expect(events[1].data).toEqual({ y: 2 });
  });

  it("tolerates CRLF line endings", async () => {
    const wire = '{"type":"message_complete","data":{}}\r\n';
    const events = await collect_ndjson(string_to_stream(wire));
    expect(events).toHaveLength(1);
  });

  it("accepts a final line without trailing newline", async () => {
    const wire = '{"type":"message_complete","data":{}}';
    const events = await collect_ndjson(string_to_stream(wire));
    expect(events).toHaveLength(1);
  });

  it("throws on malformed JSON by default", async () => {
    await expect(collect_ndjson(string_to_stream("not json\n"))).rejects.toThrow(/failed to parse/);
  });

  it("skips malformed lines when configured", async () => {
    const wire = 'not json\n{"type":"message_complete","data":{}}\n';
    const events = await collect_ndjson(string_to_stream(wire), { on_parse_error: "skip" });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message_complete");
  });

  it("invokes the parse-error callback and may inject a replacement", async () => {
    const wire = 'not json\n{"type":"message_complete","data":{}}\n';
    const events = await collect_ndjson(string_to_stream(wire), {
      on_parse_error: () => ({
        type: "lifecycle_error",
        data: { operation: "parse", error: { name: "Error", message: "bad" } },
      }),
    });
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("lifecycle_error");
  });

  it("decodes a multi-byte UTF-8 character split across chunk boundaries", async () => {
    const enc = new TextEncoder();
    const full = enc.encode('{"type":"content_update","data":{"text":"héllo"}}\n');
    const split_at = Array.from(full).findIndex((b) => b === 0xa9);
    expect(split_at).toBeGreaterThan(0);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(full.slice(0, split_at));
        controller.enqueue(full.slice(split_at));
        controller.close();
      },
    });
    const events = [];
    for await (const ev of decode_ndjson(stream)) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("content_update");
    expect((events[0].data as { text: string }).text).toBe("héllo");
  });

  describe("abort_signal", () => {
    it("returns immediately when the signal is already aborted", async () => {
      const wire = '{"type":"content_update","data":{"x":1}}\n';
      const stream = string_to_stream(wire);
      const ctrl = new AbortController();
      ctrl.abort();
      const events = [];
      for await (const ev of decode_ndjson(stream, { abort_signal: ctrl.signal })) {
        events.push(ev);
      }
      expect(events).toHaveLength(0);
    });

    it("cancels mid-stream when the signal aborts after start", async () => {
      const enc = new TextEncoder();
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          if (pulled > 5) {
            controller.close();
            return;
          }
          controller.enqueue(enc.encode(`{"type":"content_update","data":{"i":${pulled}}}\n`));
        },
      });
      const ctrl = new AbortController();
      const events = [];
      for await (const ev of decode_ndjson(stream, { abort_signal: ctrl.signal })) {
        events.push(ev);
        if (events.length === 1) {
          ctrl.abort();
        }
      }
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.length).toBeLessThan(5);
    });
  });
});
