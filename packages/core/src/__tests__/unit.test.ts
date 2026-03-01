import { describe, expect, it, vi } from "vitest";
import {
  deep_merge,
  get_nested_value,
  set_nested_value,
  delete_nested_value,
  undefined_if_empty,
} from "../utils/object.ts";
import {
  CancellationToken,
  CancellationTokenSource,
  OperationCanceledError,
  sleep,
} from "../utils/async.ts";
import { defaultRetryable, RetryPolicy } from "../policies/retry-policy.ts";
import { CompositePolicy } from "../policies/composite-policy.ts";
import { ToolContextTransformer } from "../context-transformers/tool-context-transformer.ts";
import { CheckpointContextTransformer } from "../context-transformers/checkpoint-context-transformer.ts";
import type { Message, AssistantMessage, UserMessage } from "../conversations/types.ts";
import type { PolicyErrorResult } from "../policies/types.ts";

// ---------------------------------------------------------------------------
// deep_merge
// ---------------------------------------------------------------------------
describe("deep_merge", () => {
  it("merges two flat objects", () => {
    const result = deep_merge({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("merges nested objects recursively", () => {
    const result = deep_merge({ a: { x: 1 } }, { a: { y: 2 } });
    expect(result).toEqual({ a: { x: 1, y: 2 } });
  });

  it("concatenates arrays", () => {
    const result = deep_merge([1, 2], [3, 4]);
    expect(result).toEqual([1, 2, 3, 4]);
  });

  it("supplemental null/undefined returns original", () => {
    const obj = { a: 1 };
    expect(deep_merge(obj, null as unknown as typeof obj)).toBe(obj);
    expect(deep_merge(obj, undefined as unknown as typeof obj)).toBe(obj);
  });

  it("original null/undefined returns supplemental", () => {
    const obj = { a: 1 };
    expect(deep_merge(null as unknown as typeof obj, obj)).toBe(obj);
    expect(deep_merge(undefined as unknown as typeof obj, obj)).toBe(obj);
  });

  it("throws on array/object type mismatch", () => {
    expect(() => deep_merge([1], { a: 1 } as unknown as number[])).toThrow("type mismatch");
    expect(() => deep_merge({ a: 1 }, [1] as unknown as { a: number })).toThrow("type mismatch");
  });

  it("primitives: supplemental replaces original", () => {
    expect(deep_merge("hello", "world")).toBe("world");
    expect(deep_merge(1, 2)).toBe(2);
    expect(deep_merge(true, false)).toBe(false);
  });

  it("throws on primitive type mismatch", () => {
    expect(() => deep_merge("hello", 42 as unknown as string)).toThrow("type mismatch");
  });

  it("throws on unsupported type", () => {
    const fn1 = () => {};
    const fn2 = () => {};
    expect(() => deep_merge(fn1 as unknown as string, fn2 as unknown as string)).toThrow(
      "unsupported type",
    );
  });
});

// ---------------------------------------------------------------------------
// nested value helpers
// ---------------------------------------------------------------------------
describe("nested value helpers", () => {
  it("get_nested_value with dot string path", () => {
    const obj = { a: { b: { c: 42 } } };
    expect(get_nested_value(obj, "a.b.c")).toBe(42);
  });

  it("get_nested_value with array path", () => {
    const obj = { a: { b: { c: 42 } } };
    expect(get_nested_value(obj, ["a", "b", "c"])).toBe(42);
  });

  it("get_nested_value returns undefined for missing key", () => {
    const obj = { a: { b: 1 } };
    expect(get_nested_value(obj, "a.z")).toBeUndefined();
  });

  it("set_nested_value creates intermediate objects", () => {
    const obj: Record<string, unknown> = {};
    set_nested_value(obj, "a.b.c", 42);
    expect(obj).toEqual({ a: { b: { c: 42 } } });
  });

  it("set_nested_value creates intermediate arrays for numeric keys", () => {
    const obj: Record<string, unknown> = {};
    set_nested_value(obj, ["items", 0, "name"], "test");
    expect(obj).toEqual({ items: [{ name: "test" }] });
  });

  it("set_nested_value throws on invalid key (empty path)", () => {
    const obj = {};
    expect(() => set_nested_value(obj, [], 42)).toThrow("invalid object key");
  });

  it("delete_nested_value removes a nested key", () => {
    const obj = { a: { b: { c: 42, d: 99 } } };
    delete_nested_value(obj, "a.b.c");
    expect(obj).toEqual({ a: { b: { d: 99 } } });
  });

  it("delete_nested_value is a no-op for missing path", () => {
    const obj = { a: { b: 1 } };
    delete_nested_value(obj, "a.z.y");
    expect(obj).toEqual({ a: { b: 1 } });
  });
});

// ---------------------------------------------------------------------------
// undefined_if_empty
// ---------------------------------------------------------------------------
describe("undefined_if_empty", () => {
  it("returns undefined for empty array", () => {
    expect(undefined_if_empty([])).toBeUndefined();
  });

  it("returns array for non-empty array", () => {
    const arr = [1, 2, 3];
    expect(undefined_if_empty(arr)).toBe(arr);
  });

  it("returns undefined for object with no defined keys", () => {
    expect(undefined_if_empty({ a: undefined })).toBeUndefined();
  });

  it("passes through primitives", () => {
    expect(undefined_if_empty("hello")).toBe("hello");
    expect(undefined_if_empty(42)).toBe(42);
    expect(undefined_if_empty(true)).toBe(true);
  });

  it("returns undefined for null input", () => {
    expect(undefined_if_empty(null)).toBeUndefined();
  });

  it("passes through falsy primitive 0", () => {
    expect(undefined_if_empty(0)).toBe(0);
  });

  it("passes through falsy primitive empty string", () => {
    expect(undefined_if_empty("")).toBe("");
  });

  it("passes through falsy primitive false", () => {
    expect(undefined_if_empty(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CancellationToken
// ---------------------------------------------------------------------------
describe("CancellationToken", () => {
  it("empty token is never cancelled", () => {
    const token = CancellationToken.empty();
    expect(token.is_cancellation_requested).toBe(false);
  });

  it("source.cancel() sets is_cancellation_requested", () => {
    const source = new CancellationTokenSource();
    const token = source.token;
    expect(token.is_cancellation_requested).toBe(false);
    source.cancel();
    expect(token.is_cancellation_requested).toBe(true);
  });

  it("throw_if_cancellation_requested throws OperationCanceledError", () => {
    const source = new CancellationTokenSource();
    source.cancel();
    expect(() => source.token.throw_if_cancellation_requested()).toThrow(OperationCanceledError);
  });

  it("once handler fires on cancel", () => {
    const source = new CancellationTokenSource();
    const handler = vi.fn();
    source.token.once("cancel", handler);
    source.cancel();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("dispose throws on double dispose", () => {
    const source = new CancellationTokenSource();
    source[Symbol.dispose]();
    expect(() => source[Symbol.dispose]()).toThrow("invalid state");
  });

  it("once throws after cancellation", () => {
    const source = new CancellationTokenSource();
    source.cancel();
    expect(() => source.token.once("cancel", () => {})).toThrow(OperationCanceledError);
  });
});

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------
describe("sleep", () => {
  it("resolves after delay", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  it("rejects with OperationCanceledError when token cancelled", async () => {
    const source = new CancellationTokenSource();
    const promise = sleep(5000, source.token);
    source.cancel();
    await expect(promise).rejects.toThrow(OperationCanceledError);
  });

  it("rejects immediately if token already cancelled", async () => {
    const source = new CancellationTokenSource();
    source.cancel();
    await expect(sleep(5000, source.token)).rejects.toThrow(OperationCanceledError);
  });
});

// ---------------------------------------------------------------------------
// defaultRetryable
// ---------------------------------------------------------------------------
describe("defaultRetryable", () => {
  function makeErrorResult(error: unknown): PolicyErrorResult {
    return { result: false, error, metadata: {} };
  }

  it("returns true for status 429", () => {
    expect(defaultRetryable(makeErrorResult({ status: 429 }))).toBe(true);
  });

  it("returns true for status 503", () => {
    expect(defaultRetryable(makeErrorResult({ status: 503 }))).toBe(true);
  });

  it("returns false for status 400", () => {
    expect(defaultRetryable(makeErrorResult({ status: 400 }))).toBe(false);
  });

  it("returns true for ECONNRESET code", () => {
    expect(defaultRetryable(makeErrorResult({ code: "ECONNRESET" }))).toBe(true);
  });

  it("returns true for nested cause.code ETIMEDOUT", () => {
    expect(defaultRetryable(makeErrorResult({ cause: { code: "ETIMEDOUT" } }))).toBe(true);
  });

  it('returns true for "socket hang up" message', () => {
    expect(defaultRetryable(makeErrorResult(new Error("socket hang up")))).toBe(true);
  });

  it('returns true for "fetch failed" message', () => {
    expect(defaultRetryable(makeErrorResult(new Error("fetch failed")))).toBe(true);
  });

  it("returns false for generic Error with unrelated message", () => {
    expect(defaultRetryable(makeErrorResult(new Error("something else")))).toBe(false);
  });

  it("returns true for error message containing 'timeout'", () => {
    expect(defaultRetryable(makeErrorResult(new Error("connection timeout")))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RetryPolicy.execute
// ---------------------------------------------------------------------------
describe("RetryPolicy.execute", () => {
  it("returns result on first success", async () => {
    const policy = new RetryPolicy({
      max_attempts: 3,
      initial_backoff_ms: 1,
      backoff_factor: 1,
    });
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await policy.execute(CancellationToken.empty(), fn);
    expect(result.result).toBe(true);
    if (result.result) {
      expect(result.value).toBe("ok");
    }
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries on retryable error and eventually succeeds", async () => {
    const policy = new RetryPolicy({
      max_attempts: 3,
      initial_backoff_ms: 1,
      backoff_factor: 1,
      retryable: () => true,
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockResolvedValue("ok");
    const result = await policy.execute(CancellationToken.empty(), fn);
    expect(result.result).toBe(true);
    if (result.result) {
      expect(result.value).toBe("ok");
    }
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after max_attempts and returns error", async () => {
    const policy = new RetryPolicy({
      max_attempts: 2,
      initial_backoff_ms: 1,
      backoff_factor: 1,
      retryable: () => true,
    });
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    const result = await policy.execute(CancellationToken.empty(), fn);
    expect(result.result).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable errors (returns immediately)", async () => {
    const policy = new RetryPolicy({
      max_attempts: 5,
      initial_backoff_ms: 1,
      backoff_factor: 1,
      retryable: () => false,
    });
    const fn = vi.fn().mockRejectedValue(new Error("non-retryable"));
    const result = await policy.execute(CancellationToken.empty(), fn);
    expect(result.result).toBe(false);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("metadata includes attempt count", async () => {
    const policy = new RetryPolicy({
      max_attempts: 3,
      initial_backoff_ms: 1,
      backoff_factor: 1,
      retryable: () => true,
    });
    const fn = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValue("ok");
    const result = await policy.execute(CancellationToken.empty(), fn);
    expect(result.metadata).toHaveProperty("attempts", 2);
  });

  it("applies backoff factor between retries", async () => {
    const policy = new RetryPolicy({
      max_attempts: 3,
      initial_backoff_ms: 1,
      backoff_factor: 2,
      retryable: () => true,
    });
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    const result = await policy.execute(CancellationToken.empty(), fn);
    expect(result.result).toBe(false);
    expect((result.metadata as Record<string, unknown>).lastBackoffMs).toBe(2);
  });

  it("respects cancellation token (throws OperationCanceledError)", async () => {
    const source = new CancellationTokenSource();
    const policy = new RetryPolicy({
      max_attempts: 10,
      initial_backoff_ms: 50,
      backoff_factor: 1,
      retryable: () => true,
    });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    // Cancel after a short delay so the sleep inside retry gets interrupted
    setTimeout(() => source.cancel(), 10);

    await expect(policy.execute(source.token, fn)).rejects.toThrow(OperationCanceledError);
  });

  it("propagates OperationCanceledError with default retryable logic instead of swallowing it", async () => {
    const source = new CancellationTokenSource();
    const policy = new RetryPolicy({
      max_attempts: 10,
      initial_backoff_ms: 50,
      backoff_factor: 1,
      // No custom retryable override -- uses defaultRetryable
    });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    // Cancel after a short delay so the sleep inside retry gets interrupted
    setTimeout(() => source.cancel(), 10);

    // The OperationCanceledError from sleep should propagate as a rejection,
    // not be caught and returned as { result: false, error }
    await expect(policy.execute(source.token, fn)).rejects.toThrow(OperationCanceledError);
  });
});

// ---------------------------------------------------------------------------
// CompositePolicy
// ---------------------------------------------------------------------------
describe("CompositePolicy", () => {
  it("executes single policy and returns its result", async () => {
    const retry = new RetryPolicy({
      max_attempts: 1,
      initial_backoff_ms: 1,
      backoff_factor: 1,
    });
    const composite = new CompositePolicy(retry);
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await composite.execute(CancellationToken.empty(), fn);
    expect(result.result).toBe(true);
    if (result.result) {
      expect(result.value).toBe("ok");
    }
  });

  it("chains multiple policies, merges metadata", async () => {
    const retry1 = new RetryPolicy({
      max_attempts: 1,
      initial_backoff_ms: 1,
      backoff_factor: 1,
    });
    const retry2 = new RetryPolicy({
      max_attempts: 1,
      initial_backoff_ms: 1,
      backoff_factor: 1,
    });
    const composite = new CompositePolicy(retry1, retry2);
    const fn = vi.fn().mockResolvedValue(42);
    const result = await composite.execute(CancellationToken.empty(), fn);
    expect(result.result).toBe(true);
    if (result.result) {
      expect(result.value).toBe(42);
    }
    const meta = result.metadata as Record<string, unknown>;
    expect(meta.policy).toBe("CompositePolicy");
    expect(meta.policy_count).toBe(2);
    expect(meta.policies).toBeDefined();
  });

  it("returns error result if the inner function fails", async () => {
    const composite = new CompositePolicy();
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await composite.execute(CancellationToken.empty(), fn);
    expect(result.result).toBe(false);
    if (!result.result) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });
});

// ---------------------------------------------------------------------------
// ToolContextTransformer
// ---------------------------------------------------------------------------
describe("ToolContextTransformer", () => {
  const transformer = new ToolContextTransformer();

  function assistantMsg(content: AssistantMessage["content"], id?: string): AssistantMessage {
    return { role: "assistant", content, ...(id ? { id } : {}) };
  }

  function userMsg(content: UserMessage["content"], id?: string): UserMessage {
    return { role: "user", content, ...(id ? { id } : {}) };
  }

  it("keeps tool blocks that have a matching tool_result in a later user message", async () => {
    const messages: Message[] = [
      assistantMsg([{ type: "tool", tool_request_id: "t1", tool: "search", params: {} }]),
      userMsg([{ type: "tool_result", tool_request_id: "t1", tool: "search", result: "found" }]),
    ];
    const result = await transformer.transform_prompt(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content[0]).toHaveProperty("type", "tool");
  });

  it("removes tool blocks that have no matching tool_result", async () => {
    const messages: Message[] = [
      assistantMsg([{ type: "tool", tool_request_id: "t1", tool: "search", params: {} }]),
      userMsg([{ type: "text", text: "hello" }]),
    ];
    const result = await transformer.transform_prompt(messages);
    // The assistant message had only a tool block that was removed,
    // so it should be replaced with an empty text block
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toEqual([{ type: "text", text: "" }]);
  });

  it("preserves non-tool content (text blocks) unchanged", async () => {
    const messages: Message[] = [
      assistantMsg([{ type: "text", text: "hello world" }]),
      userMsg([{ type: "text", text: "hi" }]),
    ];
    const result = await transformer.transform_prompt(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content[0]).toEqual({ type: "text", text: "hello world" });
  });

  it("replaces empty assistant message (all tools removed) with empty text block", async () => {
    const messages: Message[] = [
      assistantMsg([
        { type: "tool", tool_request_id: "t1", tool: "a", params: {} },
        { type: "tool", tool_request_id: "t2", tool: "b", params: {} },
      ]),
      userMsg([{ type: "text", text: "no results" }]),
    ];
    const result = await transformer.transform_prompt(messages);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toEqual([{ type: "text", text: "" }]);
  });

  it("removes only unmatched tool blocks, keeps text in same message", async () => {
    const messages: Message[] = [
      assistantMsg([
        { type: "text", text: "some analysis" },
        { type: "tool", tool_request_id: "t1", tool: "search", params: {} },
      ]),
      userMsg([{ type: "text", text: "thanks" }]),
    ];
    const result = await transformer.transform_prompt(messages);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toHaveLength(1);
    expect(result[0].content[0]).toEqual({ type: "text", text: "some analysis" });
  });

  it("replaces empty user message with empty text block", async () => {
    const messagesWithEmptyUser: Message[] = [
      assistantMsg([{ type: "text", text: "hi" }]),
      { role: "user", content: [] } as unknown as UserMessage,
    ];
    const result2 = await transformer.transform_prompt(messagesWithEmptyUser);
    expect(result2[1].role).toBe("user");
    expect(result2[1].content).toEqual([{ type: "text", text: "" }]);
  });
});

// ---------------------------------------------------------------------------
// CheckpointContextTransformer
// ---------------------------------------------------------------------------
describe("CheckpointContextTransformer", () => {
  const transformer = new CheckpointContextTransformer();

  function makeMessages(): Message[] {
    return [
      { role: "user", id: "m1", content: [{ type: "text", text: "first" }] },
      { role: "assistant", id: "m2", content: [{ type: "text", text: "reply1" }] },
      { role: "user", id: "m3", content: [{ type: "text", text: "second" }] },
      { role: "assistant", id: "m4", content: [{ type: "text", text: "reply2" }] },
      { role: "user", id: "m5", content: [{ type: "text", text: "third" }] },
    ];
  }

  it("returns messages unchanged when no checkpoint context", async () => {
    const msgs = makeMessages();
    const result = await transformer.transform_prompt(msgs);
    expect(result).toEqual(msgs);
  });

  it("returns messages unchanged when checkpoint message_id not found", async () => {
    const msgs = makeMessages();
    const result = await transformer.transform_prompt(msgs, {
      checkpoint: { message_id: "nonexistent", summary: "sum" },
    });
    expect(result).toEqual(msgs);
  });

  it("replaces pre-boundary messages with summary when boundary is assistant message", async () => {
    const msgs = makeMessages();
    const result = await transformer.transform_prompt(msgs, {
      checkpoint: { message_id: "m2", summary: "Summary of conversation so far." },
    });
    // boundary is m2 (assistant), so it is kept along with everything after it
    // result = [summary_message, ...messages.slice(1)] = [summary, m2, m3, m4, m5]
    expect(result.length).toBe(5);
    expect(result[0].role).toBe("user");
    expect((result[0].content[0] as { type: string; text: string }).text).toBe(
      "Summary of conversation so far.",
    );
    // m2 is kept
    expect(result[1].id).toBe("m2");
    expect(result[1].role).toBe("assistant");
  });

  it("skips boundary message when it is a user message", async () => {
    const msgs = makeMessages();
    const result = await transformer.transform_prompt(msgs, {
      checkpoint: { message_id: "m3", summary: "Summary up to m3." },
    });
    // boundary = 2 (m3, user)
    // result = [summary_message, ...messages.slice(3)] = [summary, m4, m5] = 3
    expect(result.length).toBe(3);
    expect(result[0].role).toBe("user");
    expect((result[0].content[0] as { type: string; text: string }).text).toBe("Summary up to m3.");
    // m3 is skipped, next is m4
    expect(result[1].id).toBe("m4");
  });
});
