import type { ServerResponse } from "node:http";

export interface PipeToNodeResponseOptions {
  abort_signal?: AbortSignal;
  /** Default `true`. Set `false` to write more bytes after the encoded stream. */
  end_on_close?: boolean;
}

/**
 * Pump a `ReadableStream<Uint8Array>` into a Node `ServerResponse`,
 * honoring backpressure and propagating client disconnects. Caller must
 * set status + headers before calling.
 */
export async function pipe_to_node_response(
  stream: ReadableStream<Uint8Array>,
  res: ServerResponse,
  options: PipeToNodeResponseOptions = {},
): Promise<void> {
  const reader = stream.getReader();
  const end_on_close = options.end_on_close ?? true;

  let cancelled = false;
  const cancel_reader = () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    reader.cancel().catch(() => {
      /* best effort */
    });
  };

  const on_res_close = () => {
    cancel_reader();
  };
  res.on("close", on_res_close);

  const signal = options.abort_signal;
  let on_abort: (() => void) | null = null;
  if (signal) {
    on_abort = () => {
      cancel_reader();
    };
    if (signal.aborted) {
      on_abort();
    } else {
      signal.addEventListener("abort", on_abort, { once: true });
    }
  }

  let read_error: unknown;
  try {
    while (true) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (err) {
        read_error = err;
        return;
      }
      if (result.done) {
        return;
      }
      if (res.writableEnded || res.destroyed) {
        return;
      }
      // Sync write throws (EPIPE, torn-down socket) are indistinguishable
      // from a normal disconnect — treat as "consumer gone".
      let ok: boolean;
      try {
        ok = res.write(result.value);
      } catch {
        return;
      }
      if (!ok) {
        // Race drain against close/abort so a disconnect mid-backpressure
        // can't pin the loop forever.
        await new Promise<void>((resolve) => {
          const on_drain = (): void => {
            cleanup();
            resolve();
          };
          const on_close = (): void => {
            cleanup();
            resolve();
          };
          const on_signal_abort = (): void => {
            cleanup();
            resolve();
          };
          const cleanup = (): void => {
            res.off("drain", on_drain);
            res.off("close", on_close);
            if (signal) {
              signal.removeEventListener("abort", on_signal_abort);
            }
          };
          res.once("drain", on_drain);
          res.once("close", on_close);
          if (signal) {
            if (signal.aborted) {
              cleanup();
              resolve();
              return;
            }
            signal.addEventListener("abort", on_signal_abort, { once: true });
          }
        });
        if (res.writableEnded || res.destroyed) {
          return;
        }
      }
    }
  } finally {
    res.off("close", on_res_close);
    if (signal && on_abort) {
      signal.removeEventListener("abort", on_abort);
    }
    try {
      reader.releaseLock();
    } catch {
      /* no-op */
    }
    if (read_error && !res.destroyed) {
      // Source stream errored mid-pipe — destroy the response so the client
      // sees a broken connection instead of a silently-truncated body.
      try {
        res.destroy(read_error instanceof Error ? read_error : new Error(String(read_error)));
      } catch {
        /* already torn down */
      }
    } else if (end_on_close && !res.writableEnded && !res.destroyed) {
      try {
        res.end();
      } catch {
        /* socket torn down between check and call */
      }
    }
  }
}
