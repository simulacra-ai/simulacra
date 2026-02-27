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
  claude_code_auth?: boolean;
}
```

Additional properties (`temperature`, `top_p`, etc.) spread into the API request.

If `max_tokens` is not set, it defaults to 8192.

## Claude Code Auth

When Claude Code is installed and authenticated, its stored credentials can be used instead of managing API keys. Setting `claude_code_auth: true` causes the provider to use tokens from Claude Code's stored credentials, automatically managing token lifetime and renewal.

```typescript
const provider = new AnthropicProvider(new Anthropic(), {
  model,
  claude_code_auth: true,
});
```

Claude Code auth is well-suited for local development and personal tooling where a Claude subscription is already active. Production systems should use API key authentication.

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
