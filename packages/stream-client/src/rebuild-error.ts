import type { WireError } from "@simulacra-ai/core";

export type RebuildErrorSource = "request_error" | "lifecycle_error";

export function rebuild_error(wire: WireError, source: RebuildErrorSource): Error {
  const err = new Error(wire.message);
  err.name = wire.name;
  if (wire.stack !== undefined) {
    err.stack = wire.stack;
  }
  Object.defineProperty(err, "wire_event_type", {
    value: source,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return err;
}
