import type { Conversation, UserContent, WorkflowManager } from "@simulacra-ai/core";
import type { SessionManager } from "@simulacra-ai/session";

export class SimulacraChat {
  readonly conversation: Conversation;
  readonly session?: SessionManager;
  readonly workflowManager?: WorkflowManager;

  constructor(options: {
    conversation: Conversation;
    session?: SessionManager;
    workflowManager?: WorkflowManager;
  }) {
    this.conversation = options.conversation;
    this.session = options.session;
    this.workflowManager = options.workflowManager;
  }

  get sessionId() {
    return this.session?.current_session_id;
  }

  get messages() {
    return this.conversation.messages;
  }

  async prompt(prompt: string) {
    return await this.conversation.prompt(prompt);
  }

  async sendMessage(contents: UserContent[]) {
    return await this.conversation.send_message(contents);
  }

  [Symbol.dispose]() {
    if (this.workflowManager && this.workflowManager.state !== "disposed") {
      this.workflowManager[Symbol.dispose]();
    }

    if (this.conversation.state !== "disposed") {
      this.conversation[Symbol.dispose]();
    }
  }
}
