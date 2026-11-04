import type { AgentSettingsEnvelope } from './agent-integration.js';
import type { ApiProtocol } from './api-providers.js';
import type { PermissionMode, ThinkingMode } from './chat-modes.js';
import type { CommandOutcome } from './command-output.js';

export const WORKFLOW_LIMITS = {
  tasks: 256, edges: 1024, planBytes: 768 * 1024, promptBytes: 64 * 1024,
  evidenceBytes: 64 * 1024, resultBytes: 1024 * 1024, pageSize: 200,
  globalAttempts: 4, workflowAttempts: 2, executorAttempts: 2, admissionAttempts: 3,
} as const;

export interface WorkflowRepositoryTarget {
  readonly executorId: string;
  readonly projectPath: string;
  readonly repositoryId: string;
  readonly baseCommit: string;
  readonly remote: { readonly name: string; readonly url: string } | null;
}

export interface WorkflowAgentSelection {
  readonly agentId: string;
  readonly model: string;
  readonly apiProviderId: string | null;
  readonly modelEndpointId: string | null;
  readonly modelProtocol: ApiProtocol | null;
  readonly providerRevision: number | null;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly agentSettings: AgentSettingsEnvelope;
  readonly preambles: readonly { readonly id: string; readonly contentDigest: string }[];
}

export type WorkflowOutputRequirement = 'commit' | 'summary' | 'review';
export type WorkflowAcceptance =
  | { readonly kind: 'artifact'; readonly output: WorkflowOutputRequirement }
  | { readonly kind: 'independent-review'; readonly taskId: string }
  | { readonly kind: 'approval'; readonly taskId: string };

export type WorkflowTaskSpec =
  | { readonly kind: 'agent'; readonly target: WorkflowRepositoryTarget;
      readonly selection: WorkflowAgentSelection; readonly prompt: string;
      readonly outputs: readonly WorkflowOutputRequirement[] }
  | { readonly kind: 'command'; readonly target: WorkflowRepositoryTarget;
      readonly shellModel: string; readonly command: string; readonly timeoutMs: number;
      readonly expectedExitCode: number; readonly outputRequirement: 'full-log' | 'exit-status-only' }
  | { readonly kind: 'integrate'; readonly target: WorkflowRepositoryTarget;
      readonly strategy: 'ordered-merge'; readonly inputs: readonly string[] }
  | { readonly kind: 'approval'; readonly purpose: 'publication' | 'manual';
      readonly requirements: readonly string[] }
  | { readonly kind: 'publish-pr'; readonly target: WorkflowRepositoryTarget;
      readonly sourceTaskId: string; readonly approvalTaskId: string;
      readonly baseBranch: string; readonly headBranch: string;
      readonly title: string; readonly body: string; readonly draft: boolean };

export interface WorkflowPlanTask {
  readonly id: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly spec: WorkflowTaskSpec;
  readonly acceptance: readonly WorkflowAcceptance[];
  readonly retry: { readonly maxAttempts: number; readonly backoffMs: number; readonly repeatableFailure: boolean };
}

export interface WorkflowPlan {
  readonly title: string;
  readonly goal: { readonly kind: 'artifacts' | 'pr-open'; readonly taskIds: readonly string[] };
  readonly policy: { readonly allowRemoteWrites: boolean; readonly concurrency: number };
  readonly tasks: readonly WorkflowPlanTask[];
}

export type WorkflowDesired = 'draft' | 'active' | 'paused' | 'canceled';
export type WorkflowOutcome = 'pending' | 'succeeded' | 'failed' | 'needs-attention';
export type WorkflowTaskPhase = 'blocked' | 'ready' | 'preparing' | 'running' | 'checking'
  | 'awaiting-approval' | 'succeeded' | 'failed' | 'interrupted' | 'outcome-unknown' | 'superseded' | 'canceled';
export type WorkflowDispatchPhase = 'planned' | 'preparing' | 'prepared' | 'dispatching' | 'observed-running' | 'settled';
export type WorkflowResolution = 'open' | 'succeeded' | 'failed' | 'interrupted' | 'not-started' | 'unknown' | 'abandoned';
export type WorkflowHold = 'none' | 'intervention' | 'output-unknown';

export interface WorkflowRecord {
  readonly id: string;
  readonly revision: number;
  readonly desired: WorkflowDesired;
  readonly draftPlanRevision: number;
  readonly activePlanRevision: number | null;
  readonly admissionEpoch: number;
  readonly controlEpoch: number;
  readonly title: string;
  readonly captainChatId: string | null;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowPlanRevision {
  readonly revision: number;
  readonly digest: string;
  readonly plan: WorkflowPlan;
}

export interface WorkflowTaskRecord {
  readonly workflowId: string;
  readonly id: string;
  readonly generation: number;
  readonly inputDigest: string | null;
  readonly hold: WorkflowHold;
  readonly holdReason: string | null;
  readonly nextEligibleAt: string | null;
}

export interface WorkflowAttemptIdentity {
  readonly workflowId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly attemptId: string;
  readonly inputDigest: string;
}

export interface WorkflowAttempt extends WorkflowAttemptIdentity {
  readonly planRevision: number;
  readonly dispatchPhase: WorkflowDispatchPhase;
  readonly resolution: WorkflowResolution;
  readonly controlState: 'leased' | 'revoked' | 'released';
  readonly revocationReason: string | null;
  readonly requestId: string;
  readonly serverInstanceId: string | null;
  readonly chatId: string | null;
  readonly turnId: string | null;
  readonly target: WorkflowRepositoryTarget | null;
  readonly result: WorkflowAttemptResult | null;
  readonly createdAt: string;
}

export interface WorkflowAttemptResult {
  readonly certainty: 'definite' | 'not-started' | 'unknown';
  readonly detail: string;
  readonly commandOutcome: CommandOutcome | null;
  readonly receivedOutputCoverage: 'complete' | 'gapped' | 'unknown';
  readonly outputCaptured: boolean;
}

export interface WorkflowArtifact {
  readonly id: string;
  readonly attempt: WorkflowAttemptIdentity;
  readonly digest: string;
  readonly kind: WorkflowOutputRequirement | 'command' | 'pull-request';
  readonly provenance: 'runtime-observed' | 'agent-asserted' | 'operator-attested';
  readonly outcome: 'pass' | 'fail' | 'unknown';
  readonly executorId: string | null;
  readonly repositoryId: string | null;
  readonly commit: string | null;
  readonly dirty: boolean | null;
  readonly summary: string;
  readonly url: string | null;
  readonly commandOutcome: CommandOutcome | null;
  readonly receivedOutputCoverage: 'complete' | 'gapped' | 'unknown';
  readonly observedAt: string;
}

export interface WorkflowApprovalManifest {
  readonly gateId: string;
  readonly planRevision: number;
  readonly planDigest: string;
  readonly taskId: string | null;
  readonly generation: number | null;
  readonly artifacts: readonly { readonly id: string; readonly digest: string }[];
  readonly publication: {
    readonly executorId: string; readonly repositoryId: string; readonly remoteUrl: string;
    readonly actor: string; readonly baseBranch: string; readonly headBranch: string;
    readonly headCommit: string; readonly title: string; readonly body: string;
    readonly draft: boolean; readonly operationId: string;
  } | null;
}

export interface WorkflowApproval {
  readonly gateId: string;
  readonly manifestDigest: string;
  readonly manifest: WorkflowApprovalManifest;
  readonly decision: 'approve' | 'reject';
  readonly actor: string;
  readonly at: string;
}

export interface WorkflowOperationIntent {
  readonly id: string;
  readonly attemptId: string;
  readonly kind: 'worktree' | 'transfer' | 'integrate' | 'publication' | 'cleanup';
  readonly status: 'planned' | 'dispatching' | 'succeeded' | 'not-started' | 'unknown' | 'abandoned';
  readonly payload: string;
  readonly result: string | null;
  readonly reconcileCount: number;
  readonly nextReconcileAt: string | null;
}

export interface WorkflowResourceClaim {
  readonly resourceKey: string;
  readonly attemptId: string;
  readonly executorId: string;
  readonly quarantined: boolean;
  readonly riskReleased: boolean;
}

export interface WorkflowActivity {
  readonly sequence: number;
  readonly workflowId: string;
  readonly action: string;
  readonly actor: string;
  readonly detail: string;
  readonly at: string;
}

export interface WorkflowTaskView extends WorkflowTaskRecord {
  readonly phase: WorkflowTaskPhase;
  readonly blockedReason: string | null;
  readonly attempt: WorkflowAttempt | null;
}

export interface WorkflowDetail {
  readonly workflow: WorkflowRecord;
  readonly draft: WorkflowPlanRevision;
  readonly active: WorkflowPlanRevision | null;
  readonly tasks: readonly WorkflowTaskView[];
  readonly artifacts: readonly WorkflowArtifact[];
  readonly approvals: readonly WorkflowApproval[];
  readonly gates: readonly { readonly manifest: WorkflowApprovalManifest; readonly digest: string }[];
  readonly outcome: WorkflowOutcome;
  readonly activationManifest: WorkflowApprovalManifest;
  readonly activationDigest: string;
}

export type WorkflowMutation =
  | { readonly action: 'create'; readonly plan: WorkflowPlan; readonly captainChatId: string | null }
  | { readonly action: 'plan'; readonly workflowId: string; readonly expectedPlanRevision: number; readonly plan: WorkflowPlan }
  | { readonly action: 'activate'; readonly workflowId: string; readonly manifestDigest: string }
  | { readonly action: 'pause' | 'stop' | 'cancel' | 'archive'; readonly workflowId: string }
  | { readonly action: 'resume'; readonly workflowId: string; readonly controlEpoch: number; readonly planRevision: number }
  | { readonly action: 'retry'; readonly workflowId: string; readonly taskId: string; readonly generation: number; readonly attemptId: string }
  | { readonly action: 'approve'; readonly workflowId: string; readonly gateId: string; readonly manifestDigest: string; readonly decision: 'approve' | 'reject' }
  | { readonly action: 'resolve'; readonly workflowId: string; readonly taskId: string; readonly generation: number;
      readonly attemptId: string; readonly resolution: 'not-started' | 'abandon' | 'adopt';
      readonly evidence: string; readonly commit: string | null; readonly releaseRisk: boolean };

export interface WorkflowMutationRequest {
  readonly operationId: string;
  readonly mutation: WorkflowMutation;
}

export interface WorkflowMutationResult {
  readonly operationId: string;
  readonly workflowId: string;
  readonly revision: number;
  readonly collectionRevision: number;
}

export type WorkflowOperationResult =
  | { readonly kind: 'completed'; readonly result: WorkflowMutationResult }
  | { readonly kind: 'result-expired' }
  | { readonly kind: 'not-found' };
