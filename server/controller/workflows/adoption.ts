import type { Database } from 'bun:sqlite';
import { WORKFLOW_LIMITS, type WorkflowArtifact, type WorkflowMutation } from '../../../common/workflows.js';
import { releaseSettledClaims, requireCurrentAttemptInputs } from './attempts.js';
import type { WorkflowRepositoryObservation } from './contracts.js';
import { workflowConflict } from './errors.js';
import { workflowDigest } from './inputs.js';
import { matchesManagedTarget } from './managed-target.js';
import { readAttempts, readPlan, requireAttempt, requireWorkflow } from './records.js';
import { capturePublicationAdoption, exactRecoveredPublication, type WorkflowPublicationLookup } from './publication-recovery.js';
import { assertResourceBudget } from './resources.js';

export type WorkflowAdoptionRequest = Extract<WorkflowMutation, { action: 'resolve' }>;

export function captureWorkflowAdoption(db: Database, request: WorkflowAdoptionRequest) {
  const attempt = requireAttempt(db, request.attemptId);
  const workflow = requireWorkflow(db, request.workflowId);
  if (request.resolution !== 'adopt' || request.releaseRisk || workflow.archived || workflow.desired === 'canceled'
    || attempt.workflowId !== request.workflowId || attempt.taskId !== request.taskId || attempt.generation !== request.generation
    || !['unknown', 'interrupted'].includes(attempt.resolution) || attempt.controlState === 'leased'
    || attempt.dispatchPhase !== 'settled' || attempt.revocationKind === 'superseded'
    || readAttempts(db, workflow.id).findLast(value => value.taskId === attempt.taskId)?.attemptId !== attempt.attemptId) {
    return workflowConflict('Adoption requires the current settled uncertain attempt.');
  }
  requireCurrentAttemptInputs(db, attempt);
  const task = readPlan(db, workflow.id, attempt.planRevision).plan.tasks.find(value => value.id === attempt.taskId)!;
  if (task.spec.kind === 'publish-pr') return capturePublicationAdoption(db, request, attempt, task, workflow.revision);
  if (task.spec.kind !== 'agent' || !task.spec.outputs.includes('commit') || task.spec.outputs.includes('review')
    || !request.commit || !attempt.managedTarget || !attempt.effectiveInput || attempt.result?.termination !== 'observed') {
    return workflowConflict('Commit adoption requires an observed terminal, a managed agent commit and no review output. Rerun missing checks separately.');
  }
  if (db.query(`SELECT 1 FROM artifacts WHERE attempt_id=? AND
      (json_extract(payload_json,'$.git.scope')='operator-adopted' OR
        json_extract(payload_json,'$.kind')='commit' AND json_extract(payload_json,'$.outcome')='pass')`).get(attempt.attemptId)
    || db.query("SELECT 1 FROM operation_intents WHERE attempt_id=? AND (status IN ('planned','dispatching','unknown','abandoned') OR kind='cleanup' AND status='succeeded')").get(attempt.attemptId)
    || !db.query("SELECT 1 FROM operation_intents WHERE id=? AND attempt_id=? AND kind='worktree' AND status='succeeded'").get(attempt.managedTarget.operationId, attempt.attemptId)
    || !db.query('SELECT 1 FROM resource_claims WHERE resource_key=? AND attempt_id=? AND risk_released=0')
      .get(attempt.managedTarget.resourceKey, attempt.attemptId)) {
    return workflowConflict('Adoption requires no previously accepted commit and settled, still-owned resources.');
  }
  return { kind: 'commit' as const, attempt, task, workflowRevision: workflow.revision };
}

export type WorkflowAdoptionCapture = ReturnType<typeof captureWorkflowAdoption>;
export type WorkflowAdoptionObservation = ({ readonly kind: 'commit'; readonly repository: WorkflowRepositoryObservation }
  | { readonly kind: 'publication'; readonly lookup: WorkflowPublicationLookup }) & { assertCurrent(): void };

export function commitWorkflowAdoption(db: Database, request: WorkflowAdoptionRequest, operationId: string, actor: string,
  captured: WorkflowAdoptionCapture, observed: WorkflowAdoptionObservation, now: string): string {
  const current = captureWorkflowAdoption(db, request);
  if (workflowDigest(current) !== workflowDigest(captured)) workflowConflict('Attempt or workflow changed during adoption.');
  try { observed.assertCurrent(); }
  catch { workflowConflict('Recovery observation lost its current ownership or authority.'); }
  const { attempt, task } = current;
  if (current.kind === 'publication') {
    if (observed.kind !== 'publication') return workflowConflict('Recovery observation kind changed.');
    const pull = exactRecoveredPublication(observed.lookup, current.saved);
    const content: Omit<WorkflowArtifact, 'digest'> = { id: crypto.randomUUID(), attempt: { workflowId: attempt.workflowId,
      taskId: attempt.taskId, attemptId: attempt.attemptId, generation: attempt.generation, inputDigest: attempt.inputDigest },
      kind: 'pull-request', provenance: 'operator-attested', outcome: 'pass', executorId: current.saved.publication.executorId,
      repositoryId: current.saved.publication.repositoryId, commit: pull.headCommit, dirty: null, summary: request.evidence,
      url: pull.url, commandOutcome: null, receivedOutputCoverage: 'unknown', observedAt: now, git: null };
    if (current.saved.operation.status === 'unknown') {
      const result = JSON.stringify({ kind: 'observed', value: pull, reconciled: true, adoptedBy: operationId,
        observedInstanceId: observed.lookup.instanceId });
      assertResourceBudget(db, attempt.workflowId, Buffer.byteLength(result)
        - (current.saved.operation.result === null ? WORKFLOW_LIMITS.evidenceBytes : Buffer.byteLength(current.saved.operation.result)));
      db.query("UPDATE operation_intents SET status='succeeded',result_json=? WHERE id=?").run(result, current.saved.operation.id);
    }
    db.query('INSERT INTO artifacts VALUES (?,?,?)').run(content.id, attempt.attemptId, JSON.stringify({ ...content, digest: workflowDigest(content) }));
    settleAdoption(db, attempt.attemptId, attempt.workflowId, attempt.taskId);
    return attempt.workflowId;
  }
  if (observed.kind !== 'commit') return workflowConflict('Recovery observation kind changed.');
  const resource = attempt.managedTarget!;
  const output = observed.repository;
  if (!matchesManagedTarget(resource, output.managed) || output.managed.dirty || output.executorId !== resource.target.executorId
    || output.managed.head !== request.commit || output.commit.commit !== request.commit
    || output.commit.containsAncestor !== true || request.commit === resource.head) {
    workflowConflict('Adoption requires a clean, unchanged managed identity at the requested descendant commit.');
  }
  if (task.spec.kind !== 'agent') return workflowConflict('Only agent commit output can be adopted.');
  for (const kind of task.spec.outputs) {
    const content: Omit<WorkflowArtifact, 'digest'> = { id: crypto.randomUUID(), attempt: { workflowId: attempt.workflowId,
      taskId: attempt.taskId, attemptId: attempt.attemptId, generation: attempt.generation, inputDigest: attempt.inputDigest },
      kind, provenance: 'operator-attested', outcome: 'pass', executorId: output.executorId, repositoryId: resource.target.repositoryId,
      commit: request.commit, dirty: false, summary: request.evidence, url: null, commandOutcome: null,
      receivedOutputCoverage: attempt.result!.receivedOutputCoverage, observedAt: now,
      git: { scope: 'operator-adopted', operationId, actor, evidenceDigest: workflowDigest(request.evidence),
        runtimeInstanceId: output.instanceId, repositoryIdentity: resource.repositoryIdentity, worktreeIdentity: resource.worktreeIdentity,
        projectPath: resource.target.projectPath, inputCommit: resource.head, inputTree: resource.baseTree,
        outputTree: output.commit.tree, containsInput: true } };
    const payload = JSON.stringify({ ...content, digest: workflowDigest(content) });
    if (Buffer.byteLength(payload) > WORKFLOW_LIMITS.evidenceBytes) workflowConflict('Adopted evidence exceeds its bound.');
    db.query('INSERT INTO artifacts VALUES (?,?,?)').run(content.id, attempt.attemptId, payload);
  }
  settleAdoption(db, attempt.attemptId, attempt.workflowId, attempt.taskId);
  return attempt.workflowId;
}

function settleAdoption(db: Database, attemptId: string, workflowId: string, taskId: string) {
  // Original execution certainty and revocation history remain evidence, not operator assertions.
  db.query("UPDATE attempts SET resolution='succeeded',control_state='released' WHERE id=?").run(attemptId);
  db.query("UPDATE tasks SET hold='none',hold_reason=NULL,next_eligible_at=NULL WHERE workflow_id=? AND id=?")
    .run(workflowId, taskId);
  releaseSettledClaims(db, attemptId);
}
