import type { AutomationResult, AutomationStartInput, AutomationStartResult, AutomationStopResult,
  AutomationTurnKey, EffectiveAutomationInput } from '../../../common/automation.js';
import type { WorkflowAttempt, WorkflowPlanTask, WorkflowManagedTarget, WorkflowRevocationKind } from '../../../common/workflows.js';

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
}
export interface WorkflowEffectFence {
  readonly revoked: boolean;
  readonly reason: string | null;
  readonly revocationKind: WorkflowRevocationKind | null;
  readonly revokedSignal: AbortSignal;
  readonly shutdown: AbortSignal;
}

export interface WorkflowDispatchPort {
  available(task: WorkflowPlanTask): boolean;
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
    | { kind: 'not-started' | 'unknown'; detail: string }
  >;
}

export interface WorkflowOutputFence extends WorkflowEffectFence {
  readonly outputGapped: boolean;
}

export interface WorkflowOutputPort {
  // Capture is read-only. Commit atomically validates current inputs, holds, acceptance and live fences with evidence and resolution.
  capture(attempt: WorkflowAttempt, task: WorkflowPlanTask, result: AutomationResult,
    fence: WorkflowOutputFence, signal: AbortSignal): Promise<{ commit(): void }>;
}
