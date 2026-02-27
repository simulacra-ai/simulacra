# Simulacra OpenAI Provider

The OpenAI provider allows Simulacra to use OpenAI models via the OpenAI SDK, including GPT, o1, and o3 series.

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/openai openai
```

## Usage

```typescript
import { Conversation } from "@simulacra-ai/core";
import { OpenAIProvider } from "@simulacra-ai/openai";
import OpenAI from "openai";

// create a provider and conversation
const provider = new OpenAIProvider(new OpenAI(), { model: MODEL_NAME });
using conversation = new Conversation(provider);
```

### OpenAIProviderConfig

```typescript
interface OpenAIProviderConfig {
  model: string;
  max_tokens?: number;
}
```

Additional properties (`temperature`, `top_p`, etc.) spread into the API request.

## License

MIT
