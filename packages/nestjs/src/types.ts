import type { FactoryProvider, ModuleMetadata, Type } from "@nestjs/common";
import type {
  ContextTransformer,
  ModelProvider,
  Policy,
  SummarizationStrategy,
  ToolClass,
} from "@simulacra-ai/core";
import type { SessionManagerOptions, SessionStore } from "@simulacra-ai/session";

export interface SimulacraWorkflowOptions {
  contextData?: Record<string, unknown>;
}

export interface SimulacraSessionOptions {
  autoSave?: SessionManagerOptions["auto_save"];
  autoSlug?: SessionManagerOptions["auto_slug"];
}

export interface SimulacraModuleOptions {
  provider: ModelProvider;
  policy?: Policy;
  contextTransformer?: ContextTransformer;
  summarizationStrategy?: SummarizationStrategy;
  system?: string;
  toolkit?: ToolClass[];
  workflow?: boolean | SimulacraWorkflowOptions;
  sessionStore?: SessionStore;
  session?: SimulacraSessionOptions;
}

export interface SimulacraChatOptions {
  provider?: ModelProvider;
  policy?: Policy;
  contextTransformer?: ContextTransformer;
  summarizationStrategy?: SummarizationStrategy;
  system?: string;
  toolkit?: ToolClass[];
  workflow?: boolean | SimulacraWorkflowOptions;
}

export interface SimulacraChatSessionOptions extends SimulacraChatOptions, SimulacraSessionOptions {
  sessionStore?: SessionStore;
}

export interface SimulacraChatStartOptions extends SimulacraChatSessionOptions {
  label?: string;
}

export type SimulacraChatLoadOptions = SimulacraChatSessionOptions;

export interface SimulacraOptionsFactory {
  createSimulacraOptions(): Promise<SimulacraModuleOptions> | SimulacraModuleOptions;
}

export interface SimulacraModuleAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  inject?: FactoryProvider["inject"];
  useFactory?: (...args: unknown[]) => Promise<SimulacraModuleOptions> | SimulacraModuleOptions;
  useClass?: Type<SimulacraOptionsFactory>;
  useExisting?: Type<SimulacraOptionsFactory>;
}
