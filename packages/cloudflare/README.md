# Simulacra Cloudflare Provider

The Cloudflare provider routes Simulacra conversations through a [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/), giving you caching, rate limiting, analytics, and logging on top of any supported upstream provider.

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/cloudflare openai
```

## Usage

```typescript
import { Conversation } from "@simulacra-ai/core";
import { CloudflareProvider, createCloudflareClient } from "@simulacra-ai/cloudflare";

// create an OpenAI client routed through Cloudflare AI Gateway
const client = createCloudflareClient("sk-your-openai-key", {
  accountId: "your-cloudflare-account-id",
  gatewayName: "your-gateway-name",
});

// create a provider and conversation
const provider = new CloudflareProvider(client, { model: "gpt-4o" });
using conversation = new Conversation(provider);

await conversation.prompt("Hello!");
```

### CloudflareProviderConfig

```typescript
interface CloudflareProviderConfig {
  model: string;
  max_tokens?: number;
}
```

Additional properties (`temperature`, `top_p`, etc.) spread into the API request.

### CloudflareGatewayConfig

```typescript
interface CloudflareGatewayConfig {
  accountId: string;
  gatewayName: string;
  provider?: string; // defaults to "openai"
}
```

The `provider` field controls the upstream provider path. Supported values include:

- `"openai"` — OpenAI (default)
- `"workers-ai/v1"` — Cloudflare Workers AI
- `"google-ai-studio/v1beta/openai"` — Google AI Studio (Gemini)
- `"azure-openai/{resource}/openai/deployments/{deployment}"` — Azure OpenAI

## Upstream Providers

The gateway proxies requests to any OpenAI-compatible provider. Set the `provider` field and pass the appropriate API key.

### Workers AI

```typescript
const client = createCloudflareClient("your-cloudflare-api-token", {
  accountId: "your-account-id",
  gatewayName: "your-gateway",
  provider: "workers-ai/v1",
});

const provider = new CloudflareProvider(client, {
  model: "@cf/meta/llama-3.1-8b-instruct",
});
```

### Google AI Studio (Gemini)

```typescript
const client = createCloudflareClient("your-google-ai-key", {
  accountId: "your-account-id",
  gatewayName: "your-gateway",
  provider: "google-ai-studio/v1beta/openai",
});

const provider = new CloudflareProvider(client, {
  model: "gemini-2.0-flash",
});
```

## Building the Gateway URL Manually

If you need to construct the OpenAI client yourself, `getCloudflareGatewayBaseURL` returns the base URL for a given gateway configuration.

```typescript
import { getCloudflareGatewayBaseURL } from "@simulacra-ai/cloudflare";
import OpenAI from "openai";

const baseURL = getCloudflareGatewayBaseURL({
  accountId: "your-account-id",
  gatewayName: "your-gateway",
});
// => "https://gateway.ai.cloudflare.com/v1/your-account-id/your-gateway/openai"

const client = new OpenAI({ apiKey: "sk-...", baseURL });
```

## License

MIT
