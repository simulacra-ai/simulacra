import { describe, expect, it } from "vitest";
import type { WireEvent } from "@simulacra-ai/core";
import { SSE_CONTENT_TYPE, to_sse_stream } from "../sse.ts";

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

describe("to_sse_stream", () => {
  it("frames events with `event:` + `data:` and a blank-line terminator", async () => {
    const { body, headers } = to_sse_stream(
      event_stream([
        { type: "content_update", data: { x: 1 } } as unknown as WireEvent,
        { type: "message_complete", data: { y: 2 } } as unknown as WireEvent,
      ]),
    );
    expect(headers["Content-Type"]).toBe(SSE_CONTENT_TYPE);
    const text = await read_text(body);
    const frames = text.split("\n\n").filter(Boolean);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBe(
      `event: content_update\ndata: ${JSON.stringify({ type: "content_update", data: { x: 1 } })}`,
    );
    expect(frames[1]).toBe(
      `event: message_complete\ndata: ${JSON.stringify({ type: "message_complete", data: { y: 2 } })}`,
    );
  });

  it("emits a synthetic lifecycle_error when JSON.stringify fails", async () => {
    const cyclic = { a: {} as Record<string, unknown> };
    cyclic.a.self = cyclic;
    const { body } = to_sse_stream(
      event_stream([{ type: "content_update", data: cyclic } as unknown as WireEvent]),
    );
    const text = await read_text(body);
    expect(text).toContain("event: lifecycle_error");
    expect(text).toContain('"operation":"sse_serialize"');
  });
});
