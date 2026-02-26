import { ChangeEvent, type LifecycleErrorEvent } from "../conversations/index.ts";
import { WorkflowManager } from "./workflow-manager.ts";
import { Workflow } from "./workflow.ts";

/**
 * Possible states of a workflow.
 */
export type WorkflowState = "idle" | "busy" | "disposed";

/**
 * Event data describing why a workflow ended.
 */
export type WorkflowEndEvent = { reason: "complete" | "cancel" | "error" };

/**
 * Events emitted by a Workflow instance.
 */
export interface WorkflowEvents {
  /** Emitted when the workflow state changes. */
  state_change: [ChangeEvent<WorkflowState>, Workflow];
  /** Emitted when the workflow is updated with new messages. */
  workflow_update: [Workflow];
  /** Emitted when the workflow ends. */
  workflow_end: [WorkflowEndEvent, Workflow];
  /** Emitted when a child workflow is created. */
  child_workflow_begin: [Workflow, Workflow];
  /** Emitted when a child workflow emits an event. */
  child_workflow_event: [
    {
      [E in keyof WorkflowEvents]: {
        event_name: E;
        event_args: WorkflowEvents[E];
      };
    }[keyof WorkflowEvents],
    Workflow,
  ];
  /** Emitted when a message is added to the queue. */
  message_queued: [string, Workflow];
  /** Emitted when a message is removed from the queue for sending. */
  message_dequeued: [string, Workflow];
  /** Emitted when the message queue is cleared. */
  queue_cleared: [Workflow];
  /** Emitted when an infrastructure or lifecycle operation fails. */
  lifecycle_error: [LifecycleErrorEvent, Workflow];
  /** Emitted when the workflow is disposed. */
  dispose: [Workflow];
}

/**
 * Events emitted by a WorkflowManager instance.
 */
export interface WorkflowManagerEvents {
  /** Emitted when the workflow manager state changes. */
  state_change: [ChangeEvent<WorkflowState>, WorkflowManager];
  /** Emitted when a new workflow begins. */
  workflow_begin: [Workflow, WorkflowManager];
  /** Emitted when a managed workflow emits an event. */
  workflow_event: [
    {
      [E in keyof WorkflowEvents]: {
        event_name: E;
        event_args: WorkflowEvents[E];
      };
    }[keyof WorkflowEvents],
    WorkflowManager,
  ];
  /** Emitted when an infrastructure or lifecycle operation fails. */
  lifecycle_error: [LifecycleErrorEvent, WorkflowManager];
  /** Emitted when the workflow manager is disposed. */
  dispose: [WorkflowManager];
}
