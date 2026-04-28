# Simulacra NestJS

The NestJS package wires Simulacra into Nest's dependency injection container as a singleton factory service. Instead of creating one global `Conversation` at app startup, it gives your application a `SimulacraService` that can create, start, load, and resume chats dynamically.

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/session @simulacra-ai/nestjs @nestjs/common
```

Install the model provider package you want to use as well, such as `@simulacra-ai/openai` and `openai`.

## Basic usage

```typescript
import { Module } from "@nestjs/common";
import { SimulacraModule } from "@simulacra-ai/nestjs";
import { OpenAIProvider } from "@simulacra-ai/openai";
import { FileSessionStore } from "@simulacra-ai/session";
import OpenAI from "openai";

@Module({
  imports: [
    SimulacraModule.forRoot({
      provider: new OpenAIProvider(new OpenAI(), { model: "gpt-4.1" }),
      system: "You are a helpful assistant.",
      workflow: true,
      sessionStore: new FileSessionStore("./sessions"),
    }),
  ],
})
export class AppModule {}
```

Inject `SimulacraService` into your own application service and decide which session to load.

```typescript
import { Injectable } from "@nestjs/common";
import { SimulacraService } from "@simulacra-ai/nestjs";

@Injectable()
export class AiChatService {
  constructor(private readonly simulacra: SimulacraService) {}

  async getLatestChat(sessionId?: string) {
    using chat = sessionId
      ? await this.simulacra.loadChat(sessionId)
      : await this.simulacra.loadLatestChat();

    return {
      sessionId: chat.sessionId,
      messages: chat.messages,
    };
  }

  async addNewChat(label: string) {
    using chat = await this.simulacra.startChat({ label });
    return { sessionId: chat.sessionId };
  }
}
```

In a real app, user-specific lookup usually lives in your own repository or ORM layer. For example, your `AiChatService` might first fetch the user’s most recent session ID from your database, then call `simulacra.loadChat(sessionId)`.

## Why this pattern

NestJS recommends singleton providers for most workloads and warns that request-scoped providers add overhead. This package follows that guidance by keeping one injected `SimulacraService` and creating per-chat `Conversation`, `SessionManager`, and optional `WorkflowManager` instances on demand.

That means request-specific state lives in the returned chat handle, not on a shared singleton.

## Chat lifecycle

`SimulacraService` exposes these main entry points.

- `createConversation(options?)` creates a bare `Conversation` with no session persistence
- `createChat(options?)` creates a disposable chat handle with a `Conversation` and optional `WorkflowManager`
- `startChat(options?)` creates a new persisted chat session using the configured `SessionStore`
- `loadChat(sessionId, options?)` resumes a specific persisted session
- `loadLatestChat(options?)` loads the most recent session in the configured store, or starts a new one when none exist

Each returned `SimulacraChat` exposes:

- `conversation`
- `session`
- `workflowManager`
- `sessionId`
- `messages`
- `prompt()` / `sendMessage()`

and supports `using` via `[Symbol.dispose]()` so the chat context cleans itself up when you are done.

## Async configuration

Use `forRootAsync` when your provider or store depends on `ConfigService` or another Nest provider.

```typescript
SimulacraModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    provider: new OpenAIProvider(new OpenAI({ apiKey: config.get("OPENAI_API_KEY") }), {
      model: config.getOrThrow("OPENAI_MODEL"),
    }),
    workflow: { contextData: { tenant: "default" } },
    sessionStore: new FileSessionStore(config.getOrThrow("SESSION_PATH")),
  }),
});
```

## License

MIT
