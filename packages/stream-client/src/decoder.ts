import type { WireEvent } from "@simulacra-ai/core";

export interface DecodeNdjsonOptions {
  /**
   * How to react to a line that fails JSON.parse:
   * - `"throw"` (default): raise an Error with the parse failure and a line preview.
   * - `"skip"`: silently drop the line and continue.
   * - callback `(line, error) => WireEvent | undefined`: return `undefined` to skip,
   *   or a replacement event. The returned object is yielded as-is with no shape
   *   validation — return a `lifecycle_error` envelope if you want consumers to
   *   handle it via the normal error path.
   */
  on_parse_error?: "throw" | "skip" | ((line: string, error: unknown) => WireEvent | undefined);
  /**
   * `decode_ndjson` owns the reader lock — external `source.cancel()` would
   * throw, so cancellation must come through this signal.
   */
  abort_signal?: AbortSignal;
}

/**
 * Decode an NDJSON byte stream into typed `WireEvent`s. Handles partial-line
 * buffering, UTF-8 boundaries, and CRLF.
 */
export async function* decode_ndjson(
  source: ReadableStream<Uint8Array>,
  options: DecodeNdjsonOptions = {},
): AsyncGenerator<WireEvent, void, void> {
  const on_parse_error = options.on_parse_error ?? "throw";
  const reader = source.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let aborted = false;

  const signal = options.abort_signal;
  const on_abort = (): void => {
    aborted = true;
    reader.cancel().catch(() => {
      /* swallow */
    });
  };
  if (signal) {
    if (signal.aborted) {
      on_abort();
    } else {
      signal.addEventListener("abort", on_abort, { once: true });
    }
  }

  const handle_line = (raw: string): WireEvent | undefined => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(line) as WireEvent;
    } catch (err) {
      if (on_parse_error === "throw") {
        const preview = line.length > 80 ? `${line.slice(0, 80)}…` : line;
        throw new Error(
          `decode_ndjson: failed to parse line as JSON: ${(err as Error).message} (line: ${JSON.stringify(preview)})`,
        );
      }
      if (on_parse_error === "skip") {
        return undefined;
      }
      let replacement: WireEvent | undefined;
      try {
        replacement = on_parse_error(line, err);
      } catch (cb_err) {
        throw new Error(
          `decode_ndjson: on_parse_error callback threw: ${
            (cb_err as Error).message ?? String(cb_err)
          }`,
        );
      }
      return replacement;
    }
  };

  try {
    while (true) {
      if (aborted) {
        return;
      }
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl_idx: number;
      while ((nl_idx = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, nl_idx);
        buffer = buffer.slice(nl_idx + 1);
        const event = handle_line(raw);
        if (event) {
          yield event;
        }
      }
    }
    if (aborted) {
      return;
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const event = handle_line(buffer);
      if (event) {
        yield event;
      }
    }
  } finally {
    if (signal) {
      signal.removeEventListener("abort", on_abort);
    }
    try {
      reader.releaseLock();
    } catch {
      /* no-op */
    }
  }
}

/** Drain an NDJSON stream into an array. For tests / short responses only. */
export async function collect_ndjson(
  source: ReadableStream<Uint8Array>,
  options?: DecodeNdjsonOptions,
): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  for await (const event of decode_ndjson(source, options)) {
    events.push(event);
  }
  return events;
}
