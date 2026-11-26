import type { ApiProtocol } from './api-providers.js';
import type { ExecutorId } from './executors.js';
import type { JsonObject, JsonValue } from './json.js';
import type { WorkflowAgentStep, WorkflowDefinition, WorkflowInput, WorkflowSignalReference, WorkflowStep } from './workflow-definition.js';

export interface WorkflowLocation {
  readonly executorId: ExecutorId;
  readonly projectPath: string;
}

export interface WorkflowExecutionContext {
  readonly defaultTarget?: WorkflowLocation;
  readonly projectPaths?: Readonly<Record<ExecutorId, string>>;
}

export function inheritedWorkflowPath(context: WorkflowExecutionContext, executorId: ExecutorId | undefined): string | undefined {
  if (!executorId) return undefined;
  return context.defaultTarget?.executorId === executorId ? context.defaultTarget.projectPath : context.projectPaths?.[executorId];
}

export type WorkflowAgentSettings = Pick<WorkflowAgentStep, 'agentId' | 'apiProviderId' | 'modelEndpointId'
  | 'model' | 'permissionMode' | 'thinkingMode' | 'agentSettings' | 'orderedPreambleIds' | 'attachments' | 'tags'> & {
    readonly modelProtocol?: ApiProtocol | null;
    readonly providerRevision?: number | null;
  };

export type WorkflowStepSettings =
  | ({ readonly kind: 'agent' } & WorkflowAgentSettings)
  | { readonly kind: 'command'; readonly shell?: string };

interface WorkflowLaunchRequest {
  readonly inputs: JsonObject;
  readonly executionContext?: WorkflowExecutionContext;
  readonly operationId?: string;
}

export interface WorkflowStartRequest extends WorkflowLaunchRequest {
  readonly definitionId: string;
  readonly revision?: number;
}

export interface WorkflowTestRequest extends WorkflowLaunchRequest {
  readonly source: string;
}

export interface WorkflowPublishRequest {
  readonly definitionId: string;
  readonly expectedRevision: number | null;
  readonly source: string;
}

interface WorkflowMutationRequest {
  readonly runId: string;
  readonly operationId: string;
}

export interface WorkflowDecisionRequest extends WorkflowMutationRequest {
  readonly instanceId: string;
  readonly choice: string;
}

export interface WorkflowAddItemRequest extends WorkflowMutationRequest {
  readonly stepId: string;
  readonly key: string;
  readonly payload: JsonValue;
}

export interface WorkflowAddStepRequest extends WorkflowMutationRequest {
  readonly source: string;
  readonly evidenceSignalId?: string;
  readonly executionContext?: WorkflowExecutionContext;
}

export interface WorkflowRetryRequest extends WorkflowMutationRequest {
  readonly instanceId: string;
}

export interface WorkflowStopRequest extends WorkflowMutationRequest {
  readonly instanceId?: string;
}

export type WorkflowArchiveRequest = WorkflowMutationRequest;

export interface WorkflowDefinitionSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly revision: number;
  readonly publishedAt: string;
  readonly inputs: Readonly<Record<string, WorkflowInput>>;
}

export interface WorkflowRevision {
  readonly definitionId: string | null;
  readonly revision: number | null;
  readonly source: string;
  readonly definition: WorkflowDefinition;
  readonly publishedAt: string | null;
}

export type WorkflowRunStatus = 'running' | 'waiting' | 'attention' | 'succeeded' | 'archived';
export type WorkflowInstanceStatus =
  | 'ready'
  | 'running'
  | 'waiting-executor'
  | 'awaiting-decision'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'blocked';

export interface WorkflowRunSummary {
  readonly id: string;
  readonly kind: 'published' | 'test';
  readonly definitionId: string | null;
  readonly revision: number | null;
  readonly name: string;
  readonly status: WorkflowRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowPageRequest {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface WorkflowPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface WorkflowActor {
  readonly id: string;
  readonly name: string;
}

export interface WorkflowRunArchive {
  readonly operationId: string;
  readonly actor: WorkflowActor;
  readonly createdAt: string;
}

export type WorkflowSignalSource =
  | { readonly kind: 'attempt' | 'completion'; readonly attemptId: string; readonly chatId: string; readonly turnId: string }
  | { readonly kind: 'decision' | 'manual'; readonly actor: WorkflowActor; readonly operationId: string };

export interface WorkflowSignalOccurrence {
  readonly id: string;
  readonly runId: string;
  readonly ref: WorkflowSignalReference;
  readonly instanceId: string | null;
  readonly key: string | null;
  // Omitted for a no-payload signal; JSON null is a payload.
  readonly payload?: JsonValue;
  readonly source: WorkflowSignalSource;
  readonly createdAt: string;
}

export type WorkflowTrigger =
  | { readonly kind: 'root' }
  | { readonly kind: 'signal'; readonly signalId: string }
  | { readonly kind: 'join'; readonly closeSignalId: string };

export interface WorkflowAttempt {
  readonly id: string;
  readonly number: number;
  readonly status: 'running' | 'succeeded' | 'failed' | 'unknown' | 'unavailable';
  // Reserved chat and turn IDs remain private until publication is confirmed.
  readonly chatId: string | null;
  readonly turnId: string | null;
  readonly chatAvailable: boolean;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly reason: string | null;
  readonly diagnostic: string | null;
}

export interface WorkflowStepInstance {
  readonly id: string;
  readonly key: string | null;
  readonly status: WorkflowInstanceStatus;
  readonly trigger: WorkflowTrigger;
  readonly bindings: JsonObject | null;
  readonly prompt: string | null;
  readonly reason: string | null;
  readonly attempts: readonly WorkflowAttempt[];
}

export interface WorkflowRunStep {
  readonly step: WorkflowStep;
  readonly location: WorkflowLocation | null;
  readonly settings: WorkflowStepSettings | null;
  readonly intake: 'open' | 'closed';
  readonly waitingReason: string | null;
  readonly instances: readonly WorkflowStepInstance[];
}

/** Direct listeners have one producer instance, or none yet while its intake is open. */
export function workflowProducerCanEmit(intakeOpen: boolean, status?: WorkflowInstanceStatus, attempts = 0): boolean {
  if (status === undefined) return intakeOpen;
  if (status === 'failed') return attempts < WORKFLOW_ATTEMPT_LIMIT;
  return status !== 'succeeded' && status !== 'blocked' && status !== 'unknown';
}

export const WORKFLOW_ATTEMPT_LIMIT = 16;

export type WorkflowRunAmendment = {
  readonly operationId: string;
  readonly actor: WorkflowActor;
  readonly createdAt: string;
} & (
  | { readonly kind: 'add-item'; readonly stepId: string; readonly signalId: string }
  | { readonly kind: 'add-step'; readonly stepId: string; readonly evidenceSignalId?: string }
);

export interface WorkflowRunDetail extends WorkflowRunSummary {
  readonly archive: WorkflowRunArchive | null;
  readonly pinnedRevision: WorkflowRevision;
  readonly inputs: JsonObject;
  readonly executionContext: WorkflowExecutionContext;
  readonly steps: readonly WorkflowRunStep[];
  readonly signals: readonly WorkflowSignalOccurrence[];
  readonly amendments: readonly WorkflowRunAmendment[];
}

export interface WorkflowActiveChat {
  readonly chatId: string;
  readonly runId: string;
  readonly runName: string;
  readonly runStatus: WorkflowRunStatus;
  readonly runUpdatedAt: string;
  readonly stepId: string;
  readonly instanceId: string;
  readonly attemptId: string;
  readonly status: 'running' | 'failed' | 'unknown';
}
