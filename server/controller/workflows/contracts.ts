import type { AutomationResult, AutomationStartInput, AutomationStartResult, AutomationStopResult,
  AutomationTurnKey, EffectiveAutomationInput } from '../../../common/automation.js';
import type { WorkflowAttempt, WorkflowPlan, WorkflowPlanTask, WorkflowManagedTarget, WorkflowRevocationKind } from '../../../common/workflows.js';
import type { ManagedWorktreeSnapshot } from '../../../common/git-managed-worktrees.js';
import type { CommitIdentity, IntegrateCommitsResult } from '../../../common/git-delivery.js';
import type { GitExecutorScope } from '../../../common/git-execution.js';
import type { WorkflowIntegrationManifest } from './integration-manifest.js';
import type { WorkflowAdoptionCapture, WorkflowAdoptionObservation } from './adoption.js';

export interface WorkflowAuthority {
  readonly key: string;
  readonly browserSession: boolean;
  assertCurrent(): void;
}

export interface WorkflowServiceOptions {
  readonly enabled: () => boolean;
  readonly now?: () => string;
  readonly onInvalidated?: (workflowId: string, revision: number) => void;
  readonly onControl?: (workflowId: string, action: 'pause' | 'stop' | 'cancel' | 'activate') => void;
  readonly observeAdoption?: (capture: WorkflowAdoptionCapture, signal: AbortSignal) => Promise<WorkflowAdoptionObservation>;
  readonly recheckPublication?: (operationId: string, signal: AbortSignal) => Promise<void>;
  readonly cleanup?: (operationId: string) => Promise<void>;
}
export interface WorkflowEffectFence {
  readonly revoked: boolean;
  readonly reason: string | null;
  readonly revocationKind: WorkflowRevocationKind | null;
  readonly revokedSignal: AbortSignal;
  readonly shutdown: AbortSignal;
}

export interface WorkflowDispatchPort {
  available(task: WorkflowPlanTask, plan: WorkflowPlan): boolean;
  dispatch(attempt: WorkflowAttempt, fence: WorkflowEffectFence): Promise<void>;
  stop(attempt: WorkflowAttempt, kind: WorkflowRevocationKind): Promise<void>;
}

export interface WorkflowPreparedTurn {
  readonly key: AutomationTurnKey;
  readonly effectiveInput: EffectiveAutomationInput;
  readonly control: { readonly revoked: AbortSignal; readonly outputGapped: AbortSignal; release(): void };
  start(): Promise<AutomationStartResult>;
  cancel(): Promise<void>;
}

export interface WorkflowChatPort {
  prepare(input: AutomationStartInput): Promise<{ kind: 'prepared'; turn: WorkflowPreparedTurn } | { kind: 'rejected'; code: string }>;
  waitForTerminal(key: AutomationTurnKey, signal: AbortSignal): Promise<AutomationResult>;
  stop(key: AutomationTurnKey): Promise<AutomationStopResult>;
  waitForOwnershipRelease(chatId: string, signal: AbortSignal): Promise<void>;
  inspect(chatId: string, signal: AbortSignal): Promise<{ exists: boolean; ownsExecution: boolean; pendingInput: boolean }>;
}

export interface WorkflowRepositoryPort {
  prepare(attempt: WorkflowAttempt, task: WorkflowPlanTask, fence: WorkflowEffectFence): Promise<
    | { kind: 'prepared'; resource: WorkflowManagedTarget }
    | { kind: 'not-started' | 'unknown' | 'held'; detail: string }
  >;
}

export interface WorkflowOutputFence extends WorkflowEffectFence {
  readonly outputGapped: boolean;
}

export interface WorkflowRepositoryObservation {
  readonly executorId: string;
  readonly instanceId: string;
  readonly managed: ManagedWorktreeSnapshot;
  readonly commit: CommitIdentity;
}

export interface WorkflowEvidenceRepositoryPort {
  inspect(resource: WorkflowManagedTarget, signal: AbortSignal): Promise<WorkflowRepositoryObservation>;
}

export interface WorkflowOutputPort {
  // Capture is read-only. Commit atomically validates current inputs, holds, acceptance and live fences with evidence and resolution.
  capture(attempt: WorkflowAttempt, task: WorkflowPlanTask, result: AutomationResult,
    fence: WorkflowOutputFence, signal: AbortSignal): Promise<{ commit(): void }>;
}

export type WorkflowIntegrationResult = IntegrateCommitsResult & GitExecutorScope | { readonly kind: 'not-started'; readonly reason: string };
export interface WorkflowIntegrationRepositoryPort {
  prepare(manifest: WorkflowIntegrationManifest, shutdown: AbortSignal): Promise<{ run(): Promise<WorkflowIntegrationResult> }>;
  inspect(resource: WorkflowManagedTarget, inputs: readonly string[], signal: AbortSignal): Promise<WorkflowRepositoryObservation & {
    readonly lineage: readonly { readonly commit: string; readonly containsAncestor: boolean | null }[];
  }>;
}
