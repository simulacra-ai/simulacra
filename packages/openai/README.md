# Simulacra OpenAI Provider

OpenAI chat-completions provider for Simulacra. Works against OpenAI directly (GPT, o-series) and against any OpenAI-compatible endpoint (DeepSeek, OpenRouter, self-hosted gateways like vLLM / llama.cpp / Ollama, Anthropic-via-compat, etc.).

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/openai openai
```

## Usage

```typescript
import { Conversation } from "@simulacra-ai/core";
import { OpenAIProvider } from "@simulacra-ai/openai";
import OpenAI from "openai";

const provider = new OpenAIProvider(new OpenAI(), { model: "gpt-4o" });
using conversation = new Conversation(provider);
```

For a non-OpenAI endpoint, point the SDK at it:

```typescript
const sdk = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY,
});
const provider = new OpenAIProvider(sdk, { model: "deepseek-v4-flash" });
```

## OpenAIProviderConfig

```typescript
interface OpenAIProviderConfig {
  model: string;
  max_tokens?: number;
  system_role?: "auto" | "system" | "developer";
  strict_tools?: "auto" | "never";
  upstream_reasoning?: "inline" | "field" | "drop";
}
```

Additional properties (`temperature`, `top_p`, etc.) spread into the API request.

### `system_role`

Role used for the system prompt.

- `"auto"` (default): `gpt*` → `system`, o-series (`o1`, `o3`, `o4`, ...) → `developer`, anything else → `system`. The fallback to `system` is the broadly-compatible default — most non-OpenAI endpoints reject `developer`.
- `"system"` / `"developer"`: force regardless of model id.

Set explicitly when routing through a relay using `vendor/model` ids (`openai/o3`); the heuristic only matches bare ids.

### `strict_tools`

Whether to emit OpenAI's `function.strict: true` flag on tool definitions.

- `"auto"` (default): emitted for `gpt*` and o-series. Other models get tool defs without `strict`.
- `"never"`: never emitted.

`strict` is an OpenAI-specific extension. Most other endpoints either ignore it or reject it.

### `upstream_reasoning`

Treatment of prior `thinking` content blocks when serializing assistant messages back up the wire.

- `"inline"` (default): appended as text content. OpenAI tolerates it (treated as ordinary assistant text on subsequent calls).
- `"field"`: emitted as a `reasoning_content` field on the assistant message. Required by DeepSeek V4 thinking-mode, which rejects follow-up calls when prior reasoning is missing or inlined into content.
- `"drop"`: omitted entirely.

## License

MIT
