import "reflect-metadata";

import { Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type {
  CancellationToken,
  ModelProvider,
  ModelRequest,
  StreamReceiver,
} from "@simulacra-ai/core";
import { Conversation, WorkflowManager } from "@simulacra-ai/core";
import { InMemorySessionStore } from "@simulacra-ai/session";
import { afterEach, describe, expect, it } from "vitest";

import { SimulacraModule } from "../simulacra.module.ts";
import { SimulacraService } from "../simulacra.service.ts";

class MockProvider implements ModelProvider {
  readonly context_transformers = [];

  async execute_request(
    _request: ModelRequest,
    _receiver: StreamReceiver,
    _cancellation: CancellationToken,
  ): Promise<void> {}

  clone(): ModelProvider {
    return new MockProvider();
  }
}

@Injectable()
class ProbeService {
  constructor(@Inject(SimulacraService) readonly simulacra: SimulacraService) {}
}

@Injectable()
class ConfigFactory {
  createSimulacraOptions() {
    return {
      provider: new MockProvider(),
      system: "async system",
      workflow: { contextData: { tenant: "test" } },
      sessionStore: new InMemorySessionStore(),
    };
  }
}

const syncStore = new InMemorySessionStore();

@Module({
  imports: [
    SimulacraModule.forRoot({
      provider: new MockProvider(),
      system: "sync system",
      workflow: true,
      sessionStore: syncStore,
    }),
  ],
  providers: [ProbeService],
})
class SyncTestModule {}

@Module({
  imports: [
    SimulacraModule.forRootAsync({
      useClass: ConfigFactory,
    }),
  ],
  providers: [ProbeService],
})
class AsyncTestModule {}

const apps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
});

describe("SimulacraModule (NestJS e2e)", () => {
  it("creates dynamic chat sessions from an injected service", async () => {
    const app = await NestFactory.createApplicationContext(SyncTestModule, { logger: false });
    apps.push(app);

    const probe = app.get(ProbeService);
    using chat = await probe.simulacra.startChat({ label: "sync chat" });

    expect(chat.conversation).toBeInstanceOf(Conversation);
    expect(chat.conversation.system).toBe("sync system");
    expect(chat.workflowManager).toBeInstanceOf(WorkflowManager);
    expect(chat.sessionId).toBeDefined();
  });

  it("loads persisted chat sessions dynamically", async () => {
    const app = await NestFactory.createApplicationContext(AsyncTestModule, { logger: false });
    apps.push(app);

    const probe = app.get(ProbeService);
    using created = await probe.simulacra.startChat({ label: "async chat" });
    created.conversation.load([
      {
        role: "user",
        content: [{ type: "text", text: "Hello there" }],
      },
    ]);
    await created.session?.save();

    const sessionId = created.sessionId;
    expect(sessionId).toBeDefined();
    if (!sessionId) {
      throw new Error("expected session id to be defined");
    }

    using loaded = await probe.simulacra.loadChat(sessionId);

    expect(loaded.conversation.system).toBe("async system");
    expect(loaded.workflowManager).toBeInstanceOf(WorkflowManager);
    expect(loaded.messages.length).toBeGreaterThan(0);
    expect(loaded.sessionId).toBe(sessionId);
  });
});
