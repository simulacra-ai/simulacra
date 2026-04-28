import { describe, expect, it } from "vitest";
import type {
  CancellationToken,
  ModelProvider,
  ModelRequest,
  StreamReceiver,
} from "@simulacra-ai/core";

import { SimulacraModule } from "../simulacra.module.ts";
import { SimulacraService } from "../simulacra.service.ts";
import { SIMULACRA_MODULE_OPTIONS } from "../tokens.ts";

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

describe("SimulacraModule", () => {
  it("registers synchronous options and the SimulacraService", () => {
    const provider = new MockProvider();
    const module = SimulacraModule.forRoot({ provider, system: "hello", workflow: true });

    expect(module.module).toBe(SimulacraModule);
    expect(module.providers).toHaveLength(2);
    expect(module.exports).toEqual([SimulacraService]);

    const optionsProvider = module.providers?.[0];
    expect(optionsProvider).toMatchObject({
      provide: SIMULACRA_MODULE_OPTIONS,
      useValue: { provider, system: "hello", workflow: true },
    });
    expect(module.providers?.[1]).toBe(SimulacraService);
  });

  it("registers async factory options", () => {
    const module = SimulacraModule.forRootAsync({
      inject: ["CONFIG"],
      useFactory: () => ({ provider: new MockProvider() }),
    });

    expect(module.module).toBe(SimulacraModule);
    expect(module.providers).toHaveLength(2);
    expect(module.providers?.[0]).toMatchObject({
      provide: SIMULACRA_MODULE_OPTIONS,
      inject: ["CONFIG"],
    });
    expect(module.providers?.[1]).toBe(SimulacraService);
  });
});
