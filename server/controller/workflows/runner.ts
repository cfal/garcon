import type { JsonValue } from '../../../common/json.js';
import type { WorkflowAgentStep, WorkflowCommandStep, WorkflowSignalDefinition } from '../../../common/workflow-definition.js';
import type {
  WorkflowAgentSettings, WorkflowLocation, WorkflowSignalOccurrence,
} from '../../../common/workflow-runs.js';

export type WorkflowExecutableStep = WorkflowAgentStep | WorkflowCommandStep;

export type WorkflowAttemptRequest = {
  readonly runId: string;
  readonly stepId: string;
  readonly instanceId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly location: WorkflowLocation;
} & (
  | { readonly kind: 'agent'; readonly settings: WorkflowAgentSettings; readonly prompt: string;
    readonly signals: Readonly<Record<string, WorkflowSignalDefinition>> }
  | { readonly kind: 'command'; readonly shell?: string; readonly command: string }
);

export interface WorkflowEmitRequest {
  readonly signal: string;
  readonly key?: string;
  readonly payload?: JsonValue;
}

export interface WorkflowAttemptCallbacks {
  readonly signal: AbortSignal;
  // Reserves the exact chat and turn before submission can have any side effect.
  attachChat(chatId: string, turnId: string): void;
  // Records positive confirmation that this attempt's reserved chat was published.
  confirmChat(): void;
  // The runner calls this only for an authorized emit on that exact live turn.
  emit(request: WorkflowEmitRequest): WorkflowSignalOccurrence;
}

export type WorkflowAttemptResult =
  | { readonly kind: 'succeeded'; readonly output?: { readonly kind: 'complete'; readonly text: string } | { readonly kind: 'incomplete' } }
  | { readonly kind: 'failed' | 'unknown' | 'unavailable'; readonly reason: string };

export interface WorkflowRunner {
  run(request: WorkflowAttemptRequest, callbacks: WorkflowAttemptCallbacks): Promise<WorkflowAttemptResult>;
}
