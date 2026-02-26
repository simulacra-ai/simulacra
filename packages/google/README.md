# Simulacra Google Provider

Google Gemini provider for the Simulacra conversation engine.

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/google @google/genai
```

## Usage

```typescript
import { Conversation } from "@simulacra-ai/core";
import { GoogleProvider } from "@simulacra-ai/google";
import { GoogleGenAI } from "@google/genai";

const provider = new GoogleProvider(new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY }), {
  model: MODEL_NAME,
});
const conversation = new Conversation(provider);
```

### GoogleProviderConfig

```typescript
interface GoogleProviderConfig {
  model: string;
  max_tokens?: number;
  thinking?: { enable: boolean; budget_tokens?: number };
}
```

Additional properties spread into the Gemini `config` object in the API request.

## Thinking

```typescript
const provider = new GoogleProvider(sdk, {
  model,
  max_tokens: 8192,
  thinking: { enable: true, budget_tokens: 10000 },
});
```

## GoogleToolCodeContextTransformer

Gemini models sometimes emit tool calls as inline code blocks instead of structured function calls. `GoogleToolCodeContextTransformer` intercepts these and converts them to standard `ToolContent` entries so the workflow engine can execute them.

This transformer is bundled with `GoogleProvider` by default as a provider context transformer — no manual wiring needed. To disable it, pass an empty array:

```typescript
const provider = new GoogleProvider(sdk, config, []);
```

## License

MIT
