import { describe, expect, it, vi } from "vitest";
import type { WireEvent } from "@simulacra-ai/core";
import { RemoteConversation } from "../remote-conversation.ts";

async function* events(...items: WireEvent[]): AsyncGenerator<WireEvent> {
  for (const e of items) {
    yield e;
  }
}

describe("RemoteConversation", () => {
  it("dispatches events to listeners and returns the aggregated result", async () => {
    const conv = new RemoteConversation(
      events(
        {
          type: "content_update",
          data: { content: { type: "text", text: "hi" }, content_index: 0 },
        } as unknown as WireEvent,
        {
          type: "message_complete",
          data: {
            request_id: "r1",
            usage: {},
            stop_reason: "end_turn",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hi there" }],
            },
          },
        } as unknown as WireEvent,
      ),
    );
    const on_content = vi.fn();
    const on_complete = vi.fn();
    conv.on("content_update", on_content);
    conv.on("message_complete", on_complete);

    const result = await conv.consume();

    expect(on_content).toHaveBeenCalledOnce();
    expect(on_content.mock.calls[0][0].content.text).toBe("hi");
    expect(on_complete).toHaveBeenCalledOnce();
    expect(result.text).toBe("hi there");
  });

  it("supports off() to unregister listeners", async () => {
    const conv = new RemoteConversation(
      events(
        {
          type: "content_update",
          data: { content: { type: "text", text: "a" }, content_index: 0 },
        } as unknown as WireEvent,
        {
          type: "content_update",
          data: { content: { type: "text", text: "ab" }, content_index: 0 },
        } as unknown as WireEvent,
      ),
    );
    const listener = vi.fn();
    conv.on("content_update", listener);
    conv.off("content_update", listener);
    await conv.consume();
    expect(listener).not.toHaveBeenCalled();
  });

  it("once() fires at most once", async () => {
    const conv = new RemoteConversation(
      events(
        {
          type: "content_update",
          data: { content: { type: "text", text: "a" }, content_index: 0 },
        } as unknown as WireEvent,
        {
          type: "content_update",
          data: { content: { type: "text", text: "ab" }, content_index: 0 },
        } as unknown as WireEvent,
      ),
    );
    const listener = vi.fn();
    conv.once("content_update", listener);
    await conv.consume();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("dispatches the error event before throwing", async () => {
    const conv = new RemoteConversation(
      events({
        type: "request_error",
        data: {
          request_id: "r1",
          error: { name: "ProviderError", message: "bad" },
        },
      } as unknown as WireEvent),
    );
    const on_error = vi.fn();
    conv.on("request_error", on_error);
    await expect(conv.consume()).rejects.toThrow(/bad/);
    expect(on_error).toHaveBeenCalledOnce();
  });

  it("rejects on a second consume()", async () => {
    const conv = new RemoteConversation(events());
    await conv.consume();
    await expect(conv.consume()).rejects.toThrow(/already consumed/);
  });

  it("does not let a buggy listener poison the dispatch", async () => {
    const conv = new RemoteConversation(
      events({
        type: "content_update",
        data: { content: { type: "text", text: "a" }, content_index: 0 },
      } as unknown as WireEvent),
    );
    conv.on("content_update", () => {
      throw new Error("listener bug");
    });
    const second = vi.fn();
    conv.on("content_update", second);
    await conv.consume();
    expect(second).toHaveBeenCalledOnce();
  });
});
