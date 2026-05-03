import EventEmitter from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Conversation } from "@simulacra-ai/core";
import type { WireEvent } from "@simulacra-ai/core";
import { encode_conversation } from "../encoder.ts";

interface MockHandle {
  conv: Conversation;
  emitter: EventEmitter;
  cancel_response: ReturnType<typeof vi.fn>;
}

function make_mock_conversation(): MockHandle {
  const emitter = new EventEmitter();
  const cancel_response = vi.fn();
  const conv = {
    on: (name: string, listener: (...args: unknown[]) => void) => {
      emitter.on(name, listener);
    },
    off: (name: string, listener: (...args: unknown[]) => void) => {
      emitter.off(name, listener);
    },
    once: (name: string, listener: (...args: unknown[]) => void) => {
      emitter.once(name, listener);
    },
    cancel_response,
  } as unknown as Conversation;
  return { conv, emitter, cancel_response };
}

async function read_events(stream: ReadableStream<WireEvent>): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    events.push(value);
  }
  return events;
}

describe("encode_conversation", () => {
  describe("prompt_send is gated behind include_prompt_send", () => {
    it("does not emit prompt_send by default even with everything else enabled", async () => {
      const { conv, emitter } = make_mock_conversation();
      const stream = encode_conversation(conv, {
        events: [
          "state_change",
          "message_start",
          "message_update",
          "message_complete",
          "content_start",
          "content_update",
          "content_complete",
          "request_error",
          "lifecycle_error",
        ],
      });

      emitter.emit("prompt_send", {
        request_id: "r1",
        message: { role: "user", content: [{ type: "text", text: "secret prompt" }] },
      });
      emitter.emit("message_complete", {
        request_id: "r1",
        usage: {},
        message: { role: "assistant", content: [] },
        stop_reason: "end_turn",
      });

      const events = await read_events(stream);
      const types = events.map((e) => e.type);
      expect(types).not.toContain("prompt_send");
      expect(JSON.stringify(events)).not.toContain("secret prompt");
    });

    it("emits prompt_send when include_prompt_send=true", async () => {
      const { conv, emitter } = make_mock_conversation();
      const stream = encode_conversation(conv, {
        include_prompt_send: true,
      });

      emitter.emit("prompt_send", {
        request_id: "r1",
        message: { role: "user", content: [{ type: "text", text: "explicit opt-in" }] },
      });
      emitter.emit("message_complete", {
        request_id: "r1",
        usage: {},
        message: { role: "assistant", content: [] },
        stop_reason: "end_turn",
      });

      const events = await read_events(stream);
      expect(events.map((e) => e.type)).toContain("prompt_send");
    });

    it("strips user prompt from request_error wire shape", async () => {
      const { conv, emitter } = make_mock_conversation();
      const stream = encode_conversation(conv, {
        events: ["request_error"],
      });

      emitter.emit("request_error", {
        request_id: "r1",
        message: { role: "user", content: [{ type: "text", text: "secret prompt" }] },
        error: new Error("boom"),
      });

      const events = await read_events(stream);
      const json = JSON.stringify(events);
      expect(json).not.toContain("secret prompt");
      expect(json).toContain("boom");
    });
  });

  it("calls conversation.cancel_response when the consumer cancels the stream", async () => {
    const { conv, emitter, cancel_response } = make_mock_conversation();
    const stream = encode_conversation(conv);

    const reader = stream.getReader();
    emitter.emit("message_start", {
      request_id: "r1",
      usage: {},
      message: {},
    });
    await reader.read();
    await reader.cancel();

    expect(cancel_response).toHaveBeenCalledOnce();
  });

  it("does not call cancel_response a second time after a clean message_complete close", async () => {
    const { conv, emitter, cancel_response } = make_mock_conversation();
    const stream = encode_conversation(conv);

    emitter.emit("message_complete", {
      request_id: "r1",
      usage: {},
      message: { role: "assistant", content: [] },
      stop_reason: "end_turn",
    });

    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }
    await reader.cancel();
    expect(cancel_response).not.toHaveBeenCalled();
  });

  it("closes the stream after message_complete", async () => {
    const { conv, emitter } = make_mock_conversation();
    const stream = encode_conversation(conv, {
      events: ["message_start", "content_complete", "message_complete"],
    });

    emitter.emit("message_start", { request_id: "r1", usage: {}, message: {} });
    emitter.emit("content_complete", {
      request_id: "r1",
      usage: {},
      message: {},
      content: { type: "text", text: "hello" },
    });
    emitter.emit("message_complete", {
      request_id: "r1",
      usage: {},
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      stop_reason: "end_turn",
    });

    const events = await read_events(stream);
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "content_complete",
      "message_complete",
    ]);
  });

  it("serializes errors and closes the stream on request_error", async () => {
    const { conv, emitter } = make_mock_conversation();
    const stream = encode_conversation(conv, { events: ["request_error"] });

    emitter.emit("request_error", {
      request_id: "r1",
      message: { role: "user", content: [] },
      error: new Error("boom"),
    });

    const events = await read_events(stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("request_error");
    if (events[0].type === "request_error") {
      expect(events[0].data.error).toEqual({ name: "Error", message: "boom" });
    }
  });

  it("ignores events not in the enabled list", async () => {
    const { conv, emitter } = make_mock_conversation();
    const stream = encode_conversation(conv, { events: ["content_complete"] });

    emitter.emit("message_start", { request_id: "r1", usage: {}, message: {} });
    emitter.emit("content_update", {
      request_id: "r1",
      usage: {},
      message: {},
      content: { type: "text", text: "h" },
    });
    emitter.emit("content_complete", {
      request_id: "r1",
      usage: {},
      message: {},
      content: { type: "text", text: "hi" },
    });
    emitter.emit("message_complete", {
      request_id: "r1",
      usage: {},
      message: {},
      stop_reason: "end_turn",
    });

    const events = await read_events(stream);
    expect(events.map((e) => e.type)).toEqual(["content_complete"]);
  });

  it("applies the transform option and can drop events", async () => {
    const { conv, emitter } = make_mock_conversation();
    const stream = encode_conversation(conv, {
      events: ["content_update", "content_complete"],
      transform: (event) => (event.type === "content_update" ? undefined : event),
    });

    emitter.emit("content_update", {
      request_id: "r1",
      usage: {},
      message: {},
      content: { type: "text", text: "x" },
    });
    emitter.emit("content_complete", {
      request_id: "r1",
      usage: {},
      message: {},
      content: { type: "text", text: "x" },
    });
    emitter.emit("message_complete", {
      request_id: "r1",
      usage: {},
      message: {},
      stop_reason: "end_turn",
    });

    const events = await read_events(stream);
    expect(events.map((e) => e.type)).toEqual(["content_complete"]);
  });

  it("ignores a transform that tries to change event type", async () => {
    const { conv, emitter } = make_mock_conversation();
    const stream = encode_conversation(conv, {
      events: ["content_update", "message_complete"],
      // Hostile/buggy transform: tries to rewrite content_update as state_change.
      transform: (e) =>
        e.type === "content_update"
          ? ({ type: "state_change", data: { from: "x", to: "y" } } as unknown as WireEvent)
          : e,
    });

    emitter.emit("content_update", {
      request_id: "r1",
      content: { type: "text", text: "hi" },
      index: 0,
    });
    emitter.emit("message_complete", {
      request_id: "r1",
      usage: {},
      message: { role: "assistant", content: [] },
      stop_reason: "end_turn",
    });

    const events = await read_events(stream);
    // Type re-mapping is rejected; a lifecycle_error is surfaced and the
    // original event passes through.
    expect(events.map((e) => e.type)).toEqual([
      "lifecycle_error",
      "content_update",
      "message_complete",
    ]);
    if (events[0].type === "lifecycle_error") {
      expect(events[0].data.operation).toBe("encoder_transform");
      expect(events[0].data.error.message).toMatch(/type changes are not allowed/);
    }
  });

  it("closes cleanly on conversation dispose", async () => {
    const { conv, emitter } = make_mock_conversation();
    const stream = encode_conversation(conv, { events: [] });
    emitter.emit("dispose");
    const events = await read_events(stream);
    expect(events).toEqual([]);
  });

  describe("abort_signal", () => {
    it("calls cancel_response and closes the stream when aborted mid-stream", async () => {
      const { conv, cancel_response } = make_mock_conversation();
      const ctrl = new AbortController();
      const stream = encode_conversation(conv, {
        events: [],
        abort_signal: ctrl.signal,
      });

      ctrl.abort();
      const events = await read_events(stream);
      expect(cancel_response).toHaveBeenCalledOnce();
      expect(events).toEqual([]);
    });

    it("closes immediately if the signal is already aborted", async () => {
      const { conv, cancel_response } = make_mock_conversation();
      const ctrl = new AbortController();
      ctrl.abort();
      const stream = encode_conversation(conv, {
        events: [],
        abort_signal: ctrl.signal,
      });

      const events = await read_events(stream);
      expect(cancel_response).toHaveBeenCalledOnce();
      expect(events).toEqual([]);
    });
  });

  describe("timeout_ms", () => {
    it("emits lifecycle_error and closes the stream after the timeout fires", async () => {
      vi.useFakeTimers();
      try {
        const { conv, cancel_response } = make_mock_conversation();
        const stream = encode_conversation(conv, {
          events: ["lifecycle_error"],
          timeout_ms: 50,
        });

        vi.advanceTimersByTime(60);
        const events = await read_events(stream);

        expect(cancel_response).toHaveBeenCalledOnce();
        expect(events.map((e) => e.type)).toEqual(["lifecycle_error"]);
        if (events[0].type === "lifecycle_error") {
          expect(events[0].data.operation).toBe("encoder_timeout");
          expect(events[0].data.error.message).toMatch(/timed out/);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not fire if the conversation completes first", async () => {
      vi.useFakeTimers();
      try {
        const { conv, emitter, cancel_response } = make_mock_conversation();
        const stream = encode_conversation(conv, {
          events: ["message_complete"],
          timeout_ms: 1000,
        });

        emitter.emit("message_complete", {
          request_id: "r1",
          usage: {},
          message: { role: "assistant", content: [] },
          stop_reason: "end_turn",
        });
        vi.advanceTimersByTime(2000);

        const events = await read_events(stream);
        expect(cancel_response).not.toHaveBeenCalled();
        expect(events.map((e) => e.type)).toEqual(["message_complete"]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
