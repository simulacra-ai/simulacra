# Simulacra Anthropic Provider

Anthropic Claude provider for the Simulacra conversation engine.

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/anthropic @anthropic-ai/sdk
```

## Usage

```typescript
import { Conversation } from "@simulacra-ai/core";
import { AnthropicProvider } from "@simulacra-ai/anthropic";
import Anthropic from "@anthropic-ai/sdk";

const provider = new AnthropicProvider(new Anthropic(), { model: MODEL_NAME });
const conversation = new Conversation(provider);
```

### AnthropicProviderConfig

```typescript
interface AnthropicProviderConfig {
  model: string;
  max_tokens?: number;
  thinking?: { enable: boolean; budget_tokens?: number };
  prompt_caching?: { system_prompt?: boolean; toolkit?: boolean };
}
```

Additional properties (`temperature`, `top_p`, etc.) spread into the API request.

## Extended Thinking

Enable extended thinking to capture the model's chain-of-thought as `ThinkingMessageContent` blocks.

```typescript
const provider = new AnthropicProvider(new Anthropic(), {
  model,
  max_tokens: 16384,
  thinking: { enable: true, budget_tokens: 10000 },
});
```

Both `thinking` and `redacted_thinking` blocks from the API are converted to Simulacra's `ThinkingMessageContent` type. If `max_tokens` is not set, it defaults to 8192.

## Prompt Caching

Prompt caching is enabled by default. The provider adds `cache_control` markers to the system prompt and tool definitions, avoiding re-processing static content on every turn.

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

Cache writes cost slightly more per token than standard requests. Multi-turn conversations benefit because subsequent turns read from the cache at a reduced rate. Disable by setting both flags to `false`.

## License

MIT
