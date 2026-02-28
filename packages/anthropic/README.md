# Simulacra Anthropic Provider

The Anthropic provider allows Simulacra to use Claude models via the Anthropic API, with support for extended thinking and prompt caching.

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/anthropic @anthropic-ai/sdk
```

## Usage

```typescript
import { Conversation } from "@simulacra-ai/core";
import { AnthropicProvider } from "@simulacra-ai/anthropic";
import Anthropic from "@anthropic-ai/sdk";

// create a provider and conversation
const provider = new AnthropicProvider(new Anthropic(), { model: MODEL_NAME });
using conversation = new Conversation(provider);
```

### AnthropicProviderConfig

```typescript
interface AnthropicProviderConfig {
  model: string;
  max_tokens?: number;
  thinking?: { enable: boolean; budget_tokens?: number };
  prompt_caching?: { system_prompt?: boolean; toolkit?: boolean };
  request_options?: Anthropic.RequestOptions | (() => Anthropic.RequestOptions | Promise<Anthropic.RequestOptions>);
}
```

Additional properties (`temperature`, `top_p`, etc.) spread into the API request.

If `max_tokens` is not set, it defaults to 8192.

## Request Options

The `request_options` field passes custom options to every Anthropic SDK call. It accepts a static `Anthropic.RequestOptions` object or a function that returns one (synchronously or as a promise). A function is useful when options need to be computed at request time, for example to resolve a fresh OAuth token.

```typescript
const provider = new AnthropicProvider(new Anthropic(), {
  model,
  request_options: async () => ({
    headers: {
      "x-api-key": null,
      "authorization": `Bearer ${await get_oauth_token()}`, // don't use a Claude Code token here, doing so is against the Anthropic TOS
      "anthropic-beta": "oauth-2025-04-20",
    },
  }),
});
```

## Extended Thinking

Extended thinking captures the model's chain-of-thought reasoning as `ThinkingMessageContent` blocks in the conversation history. This makes the model's reasoning process visible and accessible alongside its regular output.

```typescript
const provider = new AnthropicProvider(new Anthropic(), {
  model,
  max_tokens: 16384,
  thinking: { enable: true, budget_tokens: 10000 },
});
```

Both `thinking` and `redacted_thinking` blocks from the API are converted to Simulacra's `ThinkingMessageContent` type.

## Prompt Caching

Prompt caching is enabled by default. The provider adds `cache_control` markers to the system prompt and tool definitions, avoiding re-processing static content on every turn. Multi-turn conversations benefit because subsequent turns read from the cache at a reduced rate.

```typescript
const provider = new AnthropicProvider(new Anthropic(), {
  model,
  max_tokens: 4096,
  prompt_caching: {
    system_prompt: true, // default
    toolkit: true, // default
  },
});
```

Cache writes cost slightly more per token than standard requests. Caching can be disabled by setting both flags to `false`.

## License

MIT
