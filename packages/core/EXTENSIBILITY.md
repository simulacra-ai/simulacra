# Extensibility

Simulacra provides extensibility points for custom context transformers, policies, and summarization strategies. For custom model providers, refer to the existing provider implementations (`@simulacra-ai/anthropic`, `@simulacra-ai/openai`, `@simulacra-ai/google`) as reference.

## Context Transformers

Context transformers are implemented via the `ContextTransformer` interface and passed to the Conversation constructor as the third argument.

```typescript
interface ContextTransformer {
  transform_prompt(messages: Message[], context?: TransformContext): Promise<Message[]>;
  transform_completion(message: AssistantMessage): Promise<AssistantMessage>;
}
```

The `transform_prompt` method receives messages before they are sent to the provider and returns modified messages. The `transform_completion` method receives the assistant's response before it is added to history and returns the modified message.

```typescript
// A token budget transformer keeps only the last N messages
import type { ContextTransformer, Message, AssistantMessage } from "@simulacra-ai/core";

class TokenBudgetTransformer implements ContextTransformer {
  #max_messages: number;

  constructor(max_messages: number) {
    this.#max_messages = max_messages;
  }

  async transform_prompt(messages: Message[]) {
    if (messages.length <= this.#max_messages) return messages;
    return messages.slice(-this.#max_messages);
  }

  async transform_completion(message: AssistantMessage) {
    return message;
  }
}
```

Multiple transformers combine using `CompositeContextTransformer`, which applies them in order. The default conversation transformer chains `ToolContextTransformer` then `CheckpointContextTransformer`.

### Provider Context Transformers

Model providers can include their own transformers via the `ProviderContextTransformer` interface. These run before conversation-level transformers and do not receive `TransformContext`. Both methods are optional.

```typescript
interface ProviderContextTransformer {
  transform_prompt?(messages: Message[]): Promise<Message[]>;
  transform_completion?(message: AssistantMessage): Promise<AssistantMessage>;
}
```

## Policies

Custom policies are created by extending the abstract `Policy` class and implementing the `execute()` method.

```typescript
abstract class Policy {
  abstract execute<TResult, TArgs extends unknown[]>(
    cancellation_token: CancellationToken,
    fn: (...args: TArgs) => Promise<TResult>,
    ...args: TArgs
  ): Promise<PolicyResult<TResult>>;
}
```

The `fn` parameter is the actual API call. The policy implementation decides whether and how to invoke it, enabling behavior like retries, rate limiting, or logging.

```typescript
// A logging policy records request duration
import { Policy, type PolicyResult, type CancellationToken } from "@simulacra-ai/core";

class LoggingPolicy extends Policy {
  async execute<TResult, TArgs extends unknown[]>(
    cancellation_token: CancellationToken,
    fn: (...args: TArgs) => Promise<TResult>,
    ...args: TArgs
  ): Promise<PolicyResult<TResult>> {
    const start = Date.now();
    try {
      const value = await fn(...args);
      console.log(`Request completed in ${Date.now() - start}ms`);
      return { result: true, metadata: { duration_ms: Date.now() - start }, value };
    } catch (error) {
      console.error(`Request failed after ${Date.now() - start}ms`);
      return { result: false, metadata: {}, error };
    }
  }
}
```

`CompositePolicy` chains multiple policies together and executes them from outer to inner. Policies that observe conversation lifecycle events (`RateLimitPolicy`, `TokenLimitPolicy`) expose an `attach(conversation)` method. The method is called after conversation construction and allows the policy to subscribe to events like `request_success`, `message_complete`, or `child_event`.

## Summarization Strategies

The `SummarizationStrategy` interface controls how checkpoint summaries are generated. The default implementation serializes the conversation into a structured prompt, but custom strategies can tailor summarization for specific domains or formats.

```typescript
interface SummarizationStrategy {
  build_prompt(context: SummarizationContext): Message[];
}

interface SummarizationContext {
  session_id: string;
  messages: readonly Message[];
  previous_checkpoint?: CheckpointState;
  system?: string;
  context?: Record<string, unknown>;
}
```

`build_prompt` returns an array of messages that will be sent to an ephemeral child conversation. The last message must have `role: "user"`. The model's response becomes the checkpoint summary.

```typescript
import type { SummarizationStrategy, SummarizationContext } from "@simulacra-ai/core";
import type { Message } from "@simulacra-ai/core";

class CompactSummarizationStrategy implements SummarizationStrategy {
  build_prompt(context: SummarizationContext): Message[] {
    const history = context.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content.find((c) => c.type === "text")?.text)
      .filter(Boolean)
      .join("\n");

    return [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Summarize these user requests in 2-3 bullet points:\n\n${history}`,
          },
        ],
      },
    ];
  }
}

// Pass to conversation constructor as the fourth argument
const conversation = new Conversation(
  provider,
  policy,
  transformer,
  new CompactSummarizationStrategy(),
);
```

The `SummarizationContext` includes the `previous_checkpoint` when this is an incremental checkpoint, allowing the strategy to build on prior summaries rather than re-summarizing from scratch.
