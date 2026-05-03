import { describe, expect, it } from "vitest";
import type { WireEvent } from "@simulacra-ai/core";
import { NDJSON_CONTENT_TYPE, to_ndjson_stream } from "../ndjson.ts";

function event_stream(events: WireEvent[]): ReadableStream<WireEvent> {
  return new ReadableStream<WireEvent>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(e);
      }
      controller.close();
    },
  });
}

async function read_text(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

describe("to_ndjson_stream", () => {
  it("frames events as one JSON per line", async () => {
    const { body, headers } = to_ndjson_stream(
      event_stream([
        { type: "content_update", data: { x: 1 } } as unknown as WireEvent,
        { type: "message_complete", data: { y: 2 } } as unknown as WireEvent,
      ]),
    );
    expect(headers["Content-Type"]).toBe(NDJSON_CONTENT_TYPE);
    const text = await read_text(body);
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ type: "content_update", data: { x: 1 } });
    expect(JSON.parse(lines[1])).toEqual({ type: "message_complete", data: { y: 2 } });
  });

  it("emits a synthetic lifecycle_error when JSON.stringify fails", async () => {
    const cyclic = { a: {} as Record<string, unknown> };
    cyclic.a.self = cyclic;
    const { body } = to_ndjson_stream(
      event_stream([{ type: "content_update", data: cyclic } as unknown as WireEvent]),
    );
    const text = await read_text(body);
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as WireEvent;
    expect(parsed.type).toBe("lifecycle_error");
    if (parsed.type === "lifecycle_error") {
      expect(parsed.data.operation).toBe("ndjson_serialize");
    }
  });
});
