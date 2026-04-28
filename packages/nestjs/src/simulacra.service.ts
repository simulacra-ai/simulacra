import { Inject, Injectable } from "@nestjs/common";
import { Conversation, WorkflowManager } from "@simulacra-ai/core";
import { SessionManager } from "@simulacra-ai/session";

import { SimulacraChat } from "./simulacra-chat.ts";
import { SIMULACRA_MODULE_OPTIONS } from "./tokens.ts";
import type {
  SimulacraChatLoadOptions,
  SimulacraChatOptions,
  SimulacraChatStartOptions,
  SimulacraModuleOptions,
  SimulacraWorkflowOptions,
} from "./types.ts";

@Injectable()
export class SimulacraService {
  readonly #options: SimulacraModuleOptions;

  constructor(@Inject(SIMULACRA_MODULE_OPTIONS) options: SimulacraModuleOptions) {
    this.#options = options;
  }

  createConversation(options: SimulacraChatOptions = {}) {
    const provider = (options.provider ?? this.#options.provider).clone();
    const conversation = new Conversation(
      provider,
      options.policy ?? this.#options.policy,
      options.contextTransformer ?? this.#options.contextTransformer,
      options.summarizationStrategy ?? this.#options.summarizationStrategy,
    );
    conversation.system = options.system ?? this.#options.system;
    conversation.toolkit = options.toolkit ?? this.#options.toolkit ?? [];
    return conversation;
  }

  createChat(options: SimulacraChatOptions = {}) {
    const conversation = this.createConversation(options);
    const workflowOptions = resolveWorkflowOptions(options.workflow, this.#options.workflow);

    return new SimulacraChat({
      conversation,
      workflowManager: createWorkflowManager(conversation, workflowOptions),
    });
  }

  async startChat(options: SimulacraChatStartOptions = {}) {
    const conversation = this.createConversation(options);
    const sessionStore = options.sessionStore ?? this.#options.sessionStore;
    if (!sessionStore) {
      throw new Error("session store is required to start a chat session");
    }

    const session = new SessionManager(sessionStore, conversation, {
      auto_save: options.autoSave ?? this.#options.session?.autoSave,
      auto_slug: options.autoSlug ?? this.#options.session?.autoSlug,
    });
    session.start_new(options.label);

    const workflowOptions = resolveWorkflowOptions(options.workflow, this.#options.workflow);

    return new SimulacraChat({
      conversation,
      session,
      workflowManager: createWorkflowManager(conversation, workflowOptions),
    });
  }

  async loadChat(sessionId: string, options: SimulacraChatLoadOptions = {}) {
    const conversation = this.createConversation(options);
    const sessionStore = options.sessionStore ?? this.#options.sessionStore;
    if (!sessionStore) {
      throw new Error("session store is required to load a chat session");
    }

    const session = new SessionManager(sessionStore, conversation, {
      auto_save: options.autoSave ?? this.#options.session?.autoSave,
      auto_slug: options.autoSlug ?? this.#options.session?.autoSlug,
    });
    await session.load(sessionId);

    const workflowOptions = resolveWorkflowOptions(options.workflow, this.#options.workflow);

    return new SimulacraChat({
      conversation,
      session,
      workflowManager: createWorkflowManager(conversation, workflowOptions),
    });
  }

  async loadLatestChat(options: SimulacraChatLoadOptions = {}) {
    const conversation = this.createConversation(options);
    const sessionStore = options.sessionStore ?? this.#options.sessionStore;
    if (!sessionStore) {
      throw new Error("session store is required to load the latest chat session");
    }

    const session = new SessionManager(sessionStore, conversation, {
      auto_save: options.autoSave ?? this.#options.session?.autoSave,
      auto_slug: options.autoSlug ?? this.#options.session?.autoSlug,
    });
    await session.load();

    const workflowOptions = resolveWorkflowOptions(options.workflow, this.#options.workflow);

    return new SimulacraChat({
      conversation,
      session,
      workflowManager: createWorkflowManager(conversation, workflowOptions),
    });
  }
}

function resolveWorkflowOptions(
  override: boolean | SimulacraWorkflowOptions | undefined,
  defaults: boolean | SimulacraWorkflowOptions | undefined,
) {
  return override ?? defaults;
}

function createWorkflowManager(
  conversation: Conversation,
  workflow: boolean | SimulacraWorkflowOptions | undefined,
) {
  if (!workflow) {
    return undefined;
  }
  return new WorkflowManager(conversation, mapWorkflowOptions(workflow));
}

function mapWorkflowOptions(workflow: boolean | SimulacraWorkflowOptions) {
  if (typeof workflow === "boolean") {
    return undefined;
  }

  return {
    context_data: workflow.contextData,
  };
}
