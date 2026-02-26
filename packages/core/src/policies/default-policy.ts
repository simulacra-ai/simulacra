import type { Policy } from "./types.ts";
import { CompositePolicy } from "./composite-policy.ts";
import { RetryPolicy } from "./retry-policy.ts";

/**
 * The default policy used when none is passed to Conversation.
 * A composite that includes retry with exponential backoff. Rate and token limits require attach(conversation) so are not in the default.
 */
export function getDefaultPolicy(): Policy {
  return new CompositePolicy(
    new RetryPolicy({
      max_attempts: 3,
      initial_backoff_ms: 1000,
      backoff_factor: 2,
    }),
  );
}
