import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { pipe_to_node_response } from "../node.ts";

/**
 * Tiny mock of `http.ServerResponse` exposing the slice
 * `pipe_to_node_response` actually uses. Backpressure simulation:
 * `write()` returns `false` after the first call until a `drain`
 * event is emitted manually.
 */
function make_mock_response() {
  const events = new EventEmitter();
  const writes: Uint8Array[] = [];
  const state = {
    writableEnded: false,
    destroyed: false,
    apply_backpressure: false,
    next_write_returns_false: false,
  };
  const res = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    once: events.once.bind(events),
    emit: events.emit.bind(events),
    write(chunk: Uint8Array): boolean {
      writes.push(chunk);
      if (state.next_write_returns_false) {
        state.next_write_returns_false = false;
        return false;
      }
      return true;
    },
    end(): void {
      state.writableEnded = true;
      // Real Node emits 'close' asynchronously after end(); match that
      // so tests don't accidentally rely on synchronous ordering.
      queueMicrotask(() => events.emit("close"));
    },
    get writableEnded() {
      return state.writableEnded;
    },
    get destroyed() {
      return state.destroyed;
    },
  };
  return { res, writes, state, events };
}

function stream_from_chunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

describe("pipe_to_node_response", () => {
  it("writes every chunk and ends the response by default", async () => {
    const { res, writes, state } = make_mock_response();
    const stream = stream_from_chunks(['{"type":"a"}\n', '{"type":"b"}\n']);

    await pipe_to_node_response(stream, res as never);

    const decoded = writes.map((w) => new TextDecoder().decode(w)).join("");
    expect(decoded).toBe('{"type":"a"}\n{"type":"b"}\n');
    expect(state.writableEnded).toBe(true);
  });

  it("waits for a drain event when write() returns false", async () => {
    const { res, writes, state, events } = make_mock_response();
    state.next_write_returns_false = true;

    const stream = stream_from_chunks(['{"type":"a"}\n', '{"type":"b"}\n']);
    const promise = pipe_to_node_response(stream, res as never);

    // Give the loop microtasks to attempt the first write (which
    // returns false) and start awaiting drain. Three microtask cycles
    // is enough to traverse: ReadableStream pull → reader.read() →
    // res.write().
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
    }
    expect(writes).toHaveLength(1);

    events.emit("drain");
    await promise;
    expect(writes).toHaveLength(2);
    expect(state.writableEnded).toBe(true);
  });

  it("cancels the reader when the response closes mid-stream", async () => {
    const { res, writes, events } = make_mock_response();

    // Seed one chunk via `start`, then leave the stream open without
    // a `pull` so the next read() blocks waiting for cancel. Avoids
    // an unbounded microtask read loop that would starve macrotasks.
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk1\n"));
      },
      cancel() {
        cancelled = true;
      },
    });

    const promise = pipe_to_node_response(stream, res as never);
    // Drain microtasks to let the pump loop reach its first await.
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
    }
    events.emit("close");
    await promise;

    expect(cancelled).toBe(true);
    expect(writes.length).toBeGreaterThan(0);
  });

  it("cancels the reader when abort_signal aborts", async () => {
    const { res } = make_mock_response();

    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x\n"));
      },
      cancel() {
        cancelled = true;
      },
    });

    const ctrl = new AbortController();
    const promise = pipe_to_node_response(stream, res as never, { abort_signal: ctrl.signal });
    // Drain microtasks to let the pump loop reach its first await.
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
    }
    ctrl.abort();
    await promise;

    expect(cancelled).toBe(true);
  });

  it("does not call res.end() when end_on_close is false", async () => {
    const { res, state } = make_mock_response();
    const stream = stream_from_chunks(['{"type":"a"}\n']);
    await pipe_to_node_response(stream, res as never, { end_on_close: false });
    expect(state.writableEnded).toBe(false);
  });
});
