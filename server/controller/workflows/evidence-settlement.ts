import type { Database } from 'bun:sqlite';
import { WORKFLOW_LIMITS, type WorkflowArtifact, type WorkflowAttempt, type WorkflowPlanTask } from '../../../common/workflows.js';
import { releaseSettledClaims, requireWorkflowInputs } from './attempts.js';
import type { WorkflowEffectFence } from './contracts.js';
import { workflowConflict } from './errors.js';
import { workflowDigest } from './inputs.js';
import { appendWorkflowActivity, readPlan, requireAttempt, requireWorkflow, workflowRevision } from './records.js';
import type { WorkflowStore } from './store.js';

export type WorkflowOutputEvidence = Pick<WorkflowArtifact, 'kind' | 'provenance' | 'outcome' | 'summary'>;
export type WorkflowCapturedArtifact = Omit<WorkflowArtifact, 'id' | 'attempt' | 'digest'>;

export class WorkflowEvidenceSettlement {
  constructor(readonly store: WorkflowStore, private readonly options: {
    readonly now: () => string; readonly onInvalidated?: (workflowId: string, revision: number) => void;
  }) {}

  requireAttempt(initial: WorkflowAttempt, task: WorkflowPlanTask, fence: WorkflowEffectFence, signal: AbortSignal): WorkflowAttempt {
    return this.store.read(db => requireEvidenceAttempt(db, initial, task, fence, signal));
  }

  commit(attempt: WorkflowAttempt, task: WorkflowPlanTask, fence: WorkflowEffectFence, signal: AbortSignal,
    evaluate: (db: Database, current: WorkflowAttempt) => readonly WorkflowCapturedArtifact[]): void {
    const revision = this.store.transaction(db => {
      const current = requireEvidenceAttempt(db, attempt, task, fence, signal);
      const outputs = evaluate(db, current);
      if (!outputs.length) return workflowConflict('The task declares no output evidence.');
      const outcome = outputs.some(output => output.outcome === 'unknown') ? 'unknown'
        : outputs.some(output => output.outcome === 'fail') ? 'fail' : 'pass';
      if (outcome === 'pass') {
        for (const requirement of task.acceptance) {
          if (requirement.kind === 'artifact' && !outputs.some(output => output.kind === requirement.output)) {
            workflowConflict('Required output was not observed.');
          }
        }
      }
      for (const output of outputs) {
        const content = { ...output, id: crypto.randomUUID(), attempt: { workflowId: current.workflowId, taskId: current.taskId,
          generation: current.generation, attemptId: current.attemptId, inputDigest: current.inputDigest } };
        const artifact: WorkflowArtifact = { ...content, digest: workflowDigest(content) };
        const payload = JSON.stringify(artifact);
        if (Buffer.byteLength(payload) > WORKFLOW_LIMITS.evidenceBytes) workflowConflict('Output evidence exceeds its bound.');
        db.query('INSERT INTO artifacts VALUES (?,?,?)').run(artifact.id, current.attemptId, payload);
      }
      const coverage = outputs[0]!.receivedOutputCoverage;
      const resolution = outcome === 'pass' ? 'succeeded' : outcome === 'fail' ? 'failed' : 'unknown';
      db.query("UPDATE attempts SET resolution=?,dispatch_phase='settled',control_state='released',result_json=? WHERE id=?")
        .run(resolution, JSON.stringify({ ...current.result, outputCaptured: true, receivedOutputCoverage: coverage }), current.attemptId);
      if (outcome === 'unknown') {
        db.query("UPDATE tasks SET hold='output-unknown',hold_reason=? WHERE workflow_id=? AND id=?")
          .run('Output could not be accepted against the prepared input.', current.workflowId, current.taskId);
        db.query('UPDATE resource_claims SET quarantined=1 WHERE attempt_id=?').run(current.attemptId);
      } else {
        releaseSettledClaims(db, current.attemptId);
        if (outcome === 'fail') db.query('UPDATE tasks SET next_eligible_at=? WHERE workflow_id=? AND id=?')
          .run(new Date(Date.parse(this.options.now()) + task.retry.backoffMs).toISOString(), current.workflowId, current.taskId);
      }
      appendWorkflowActivity(db, current.workflowId, 'evidence-observed', 'engine', current.attemptId, this.options.now());
      return workflowRevision(db);
    });
    try { this.options.onInvalidated?.(attempt.workflowId, revision); }
    catch (error) { console.error('Workflow evidence notification failed', error); }
  }
}

function requireEvidenceAttempt(db: Database, captured: WorkflowAttempt, task: WorkflowPlanTask,
  fence: WorkflowEffectFence, signal: AbortSignal): WorkflowAttempt {
  if (signal.aborted || fence.shutdown.aborted) return workflowConflict('Output observation was canceled.');
  if (fence.revoked) return workflowConflict('Output attribution was revoked.');
  const attempt = requireAttempt(db, captured.attemptId);
  const workflow = requireWorkflow(db, attempt.workflowId);
  if (attempt.resolution !== 'open' || attempt.controlState !== 'leased'
    || !['dispatching', 'observed-running'].includes(attempt.dispatchPhase)
    || attempt.result?.certainty !== 'definite' || attempt.result.termination !== 'observed' || attempt.result.outputCaptured
    || workflow.archived || workflow.desired === 'canceled'
    || workflowDigest(attempt) !== workflowDigest(captured)) {
    return workflowConflict('Evidence no longer owns this observed attempt.');
  }
  requireWorkflowInputs(db, attempt);
  const approved = readPlan(db, attempt.workflowId, attempt.planRevision).plan.tasks.find(value => value.id === attempt.taskId);
  if (workflowDigest(approved) !== workflowDigest(task)) return workflowConflict('Evidence task differs from its approved definition.');
  if (!attempt.managedTarget || !db.query(`SELECT 1 FROM resource_claims WHERE resource_key=? AND attempt_id=?
    AND quarantined=0 AND risk_released=0 AND retained=0`).get(attempt.managedTarget.resourceKey, attempt.attemptId)
    || db.query("SELECT 1 FROM operation_intents WHERE attempt_id=? AND status IN ('planned','dispatching','unknown','abandoned') LIMIT 1")
      .get(attempt.attemptId)) return workflowConflict('Evidence has no exclusively owned, settled repository input.');
  return attempt;
}
