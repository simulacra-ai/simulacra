import type { WireError } from "../conversations/types.ts";

/**
 * Convert any thrown value into a JSON-safe {@link WireError}. Stack is
 * omitted unless `include_stack` is true (stacks frequently leak server-side paths).
 */
export function serialize_error(error: unknown, include_stack: boolean): WireError {
  if (error instanceof Error) {
    const wire: WireError = { name: error.name, message: error.message };
    if (include_stack && error.stack) {
      wire.stack = error.stack;
    }
    return wire;
  }
  if (typeof error === "string") {
    return { name: "Error", message: error };
  }
  if (error === undefined) {
    return { name: "Error", message: "(undefined was thrown)" };
  }
  if (error === null) {
    return { name: "Error", message: "(null was thrown)" };
  }
  try {
    const json = JSON.stringify(error);
    if (typeof json === "string") {
      return { name: "Error", message: json };
    }
  } catch {
    /* cyclic / BigInt */
  }
  return { name: "Error", message: `(unrepresentable: ${String(error)})` };
}
