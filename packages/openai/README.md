# Simulacra OpenAI Provider

OpenAI provider for the Simulacra conversation engine.

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/openai openai
```

## Usage

```typescript
import { Conversation } from "@simulacra-ai/core";
import { OpenAIProvider } from "@simulacra-ai/openai";
import OpenAI from "openai";

const provider = new OpenAIProvider(new OpenAI(), { model: MODEL_NAME });
const conversation = new Conversation(provider);
```

### OpenAIProviderConfig

```typescript
interface OpenAIProviderConfig {
  model: string;
  max_tokens?: number;
}
```

Additional properties (`temperature`, `top_p`, etc.) spread into the API request.

## System Prompt Handling

The provider automatically selects the correct system message role based on the model:

- **GPT models** (`gpt-*`): uses `role: "system"`
- **Other models** (o1, o3, etc.): uses `role: "developer"`

## License

MIT
