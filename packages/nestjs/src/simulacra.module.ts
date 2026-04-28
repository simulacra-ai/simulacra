import { DynamicModule, Module, Provider } from "@nestjs/common";

import { SIMULACRA_MODULE_OPTIONS } from "./tokens.ts";
import { SimulacraService } from "./simulacra.service.ts";
import type {
  SimulacraModuleAsyncOptions,
  SimulacraModuleOptions,
  SimulacraOptionsFactory,
} from "./types.ts";

@Module({})
export class SimulacraModule {
  static forRoot(options: SimulacraModuleOptions): DynamicModule {
    return {
      module: SimulacraModule,
      providers: [{ provide: SIMULACRA_MODULE_OPTIONS, useValue: options }, SimulacraService],
      exports: [SimulacraService],
    };
  }

  static forRootAsync(options: SimulacraModuleAsyncOptions): DynamicModule {
    return {
      module: SimulacraModule,
      imports: options.imports,
      providers: [...createAsyncOptionsProviders(options), SimulacraService],
      exports: [SimulacraService],
    };
  }
}

function createAsyncOptionsProviders(options: SimulacraModuleAsyncOptions): Provider[] {
  if (options.useFactory) {
    return [
      {
        provide: SIMULACRA_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
    ];
  }

  const inject = [options.useExisting ?? options.useClass].filter(
    (token): token is NonNullable<typeof token> => Boolean(token),
  );

  const providers: Provider[] = [
    {
      provide: SIMULACRA_MODULE_OPTIONS,
      useFactory: (factory: SimulacraOptionsFactory) => factory.createSimulacraOptions(),
      inject,
    },
  ];

  if (options.useClass) {
    providers.push({ provide: options.useClass, useClass: options.useClass });
  }

  return providers;
}
