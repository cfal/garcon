import type { Database } from 'bun:sqlite';
import type { WorkflowAttempt, WorkflowApprovalManifest } from '../../../common/workflows.js';
import { workflowGateInputs } from './gate-inputs.js';
import { workflowConflict } from './errors.js';
import { workflowCommitInput, workflowDigest } from './inputs.js';
import { readApprovals, readDependencyArtifacts, readGateManifests, readPlan } from './records.js';
import { requireOperation } from './resource-dispatch.js';
import type { WorkflowPublicationSpec } from './publication-contracts.js';

export const workflowPublicationMarker = (operationId: string) => `<!-- garcon-workflow-publication:${operationId} -->`;

export function publicationGateSource(db: Database, workflowId: string, gateId: string) {
  const inputs = workflowGateInputs(db, workflowId, gateId);
  const task = inputs.plan.plan.tasks.find(task => task.spec.kind === 'publish-pr' && task.spec.approvalTaskId === gateId);
  if (!task || task.spec.kind !== 'publish-pr') return workflowConflict('Publication gate has no publication task.');
  const source = workflowCommitInput(task.spec.sourceTaskId, task.spec.target.repositoryId, inputs.dependencies);
  return { ...inputs, spec: task.spec, source };
}

export function requirePublicationApproval(db: Database, attempt: WorkflowAttempt) {
  const task = readPlan(db, attempt.workflowId, attempt.planRevision).plan.tasks.find(task => task.id === attempt.taskId)!;
  if (task.spec.kind !== 'publish-pr' || attempt.chatId || attempt.effectiveInput) return workflowConflict('Publication requires a non-chat attempt.');
  const spec = task.spec;
  const gate = readGateManifests(db, attempt.workflowId).find(gate => gate.manifest.gateId === spec.approvalTaskId);
  if (!gate?.manifest.publication || !readApprovals(db, attempt.workflowId).some(approval => approval.gateId === spec.approvalTaskId
    && approval.manifestDigest === gate.digest && approval.decision === 'approve')) return workflowConflict('Publication requires exact browser approval.');
  const current = publicationGateSource(db, attempt.workflowId, spec.approvalTaskId);
  const source = workflowCommitInput(spec.sourceTaskId, spec.target.repositoryId, readDependencyArtifacts(db, attempt.workflowId, task.dependsOn));
  if (workflowDigest({ ...gate.manifest, publication: null }) !== workflowDigest(current.manifest)
    || !matchesPublicationSpec(gate.manifest, spec, source.commit!)) return workflowConflict('Publication approval changed.');
  return { task, publication: gate.manifest.publication, digest: gate.digest };
}

export function matchesPublicationSpec(manifest: WorkflowApprovalManifest, spec: WorkflowPublicationSpec, head: string): boolean {
  const value = manifest.publication;
  return !!value && value.executorId === spec.target.executorId && value.repositoryId === spec.target.repositoryId
    && value.projectPath === spec.target.projectPath && value.remoteUrl === spec.target.remote?.url
    && value.headCommit === head && value.headBranch === spec.headBranch && value.baseBranch === spec.baseBranch
    && value.title === spec.title && value.draft === spec.draft
    && value.body === `${spec.body}\n\n${workflowPublicationMarker(value.operationId)}`;
}

export function publicationIntentPayload(db: Database, attempt: WorkflowAttempt, stage: 'push' | 'create'): string {
  const approved = requirePublicationApproval(db, attempt);
  if (!attempt.managedTarget || attempt.managedTarget.instanceId !== approved.publication.runtimeInstanceId
    || attempt.managedTarget.head !== approved.publication.headCommit) return workflowConflict('Publication target differs from its approved runtime and commit.');
  return JSON.stringify({ version: 1, stage, approval: approved, resource: attempt.managedTarget });
}

export function requirePublicationOperation(db: Database, attempt: WorkflowAttempt, id: string, stage: 'push' | 'create') {
  const operation = requireOperation(db, id);
  if (operation.attemptId !== attempt.attemptId || operation.kind !== 'publication'
    || operation.payload !== publicationIntentPayload(db, attempt, stage)) return workflowConflict('Publication intent changed.');
  return operation;
}
