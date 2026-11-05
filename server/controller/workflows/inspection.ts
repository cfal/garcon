import type { Database } from 'bun:sqlite';
import type { WorkflowArtifact, WorkflowAttemptInspection, WorkflowAttemptSummary, WorkflowGateInspection, WorkflowOperationView, WorkflowOverview, WorkflowResourceClaim } from '../../../common/workflows.js';
import { activationManifest, readGateManifests, readPlan, readWorkflowSchedule, requireAttempt, WORKFLOW_OPERATION_ATTENTION_SQL } from './records.js';
import { workflowConflict } from './errors.js';
import { workflowDigest } from './inputs.js';
import { workflowOutcome } from './transitions.js';

export function readWorkflowOverview(db: Database, workflowId: string): WorkflowOverview {
  const schedule = readWorkflowSchedule(db, workflowId);
  const { workflow, active } = schedule;
  const draft = readPlan(db, workflowId, workflow.draftPlanRevision);
  const manifest = activationManifest(draft);
  const tasks = schedule.tasks.map(task => {
    if (!task.attempt) return { ...task, attempt: null };
    const row = db.query<Omit<WorkflowAttemptSummary, 'result'> & { result: string | null }, [string]>(`SELECT id AS attemptId,
      workflow_id AS workflowId,task_id AS taskId,generation,input_digest AS inputDigest,plan_revision AS planRevision,
      dispatch_phase AS dispatchPhase,resolution,control_state AS controlState,chat_id AS chatId,created_at AS createdAt,
      CASE WHEN result_json IS NOT NULL THEN json_object('certainty',json_extract(result_json,'$.certainty'),
        'termination',json_extract(result_json,'$.termination'),'detail',substr(json_extract(result_json,'$.detail'),1,256)) END AS result
      FROM attempts WHERE id=?`).get(task.attempt.attemptId)!;
    return { ...task, attempt: { ...row, result: row.result ? JSON.parse(row.result) : null } };
  });
  const operations = db.query<WorkflowOperationView, [string]>(`SELECT o.id,o.attempt_id AS attemptId,o.kind,o.resource_key AS resourceKey,o.status,
    o.reconcile_count AS reconcileCount,o.next_reconcile_at AS nextReconcileAt,json_extract(o.payload_json,'$.stage') AS stage,
    substr(json_extract(o.result_json,'$.detail'),1,512) AS detail FROM operation_intents o JOIN attempts a ON a.id=o.attempt_id
    WHERE a.workflow_id=? AND ${WORKFLOW_OPERATION_ATTENTION_SQL} ORDER BY o.rowid DESC LIMIT 256`).all(workflowId);
  return { workflow, draft: { revision: draft.revision, digest: draft.digest },
    active: active ? { revision: active.revision, digest: active.digest } : null, tasks,
    outcome: workflowOutcome(active?.plan ?? null, tasks), gates: readGateManifests(db, workflowId),
    activationManifest: manifest, activationDigest: workflowDigest(manifest), operations, resources: [] };
}

export function inspectWorkflowGate(db: Database, workflowId: string, gateId: string): WorkflowGateInspection {
  const gate = readGateManifests(db, workflowId).find(gate => gate.manifest.gateId === gateId);
  if (!gate) return workflowConflict('Approval manifest is no longer available.');
  const evidence = gate.manifest.artifacts.map(reference => {
    const row = db.query<{ payload_json: string }, [string, string]>(`SELECT r.payload_json FROM artifacts r JOIN attempts a ON a.id=r.attempt_id
      WHERE a.workflow_id=? AND r.id=?`).get(workflowId, reference.id);
    if (!row) return workflowConflict('Approval evidence is no longer available.');
    const artifact: WorkflowArtifact = JSON.parse(row.payload_json);
    if (artifact.digest !== reference.digest) return workflowConflict('Approval evidence changed.');
    const { id, digest, kind, outcome, provenance, commit, receivedOutputCoverage, commandOutcome } = artifact;
    return { id, digest, kind, outcome, provenance, commit, receivedOutputCoverage,
      commandOutcome: commandOutcome ? { outcome: commandOutcome.outcome, exitCode: commandOutcome.exitCode, capture: commandOutcome.capture } : null,
      summary: artifact.summary.slice(0, 256), summaryTruncated: artifact.summary.length > 256 };
  });
  return { ...gate, evidence };
}

export function inspectWorkflowAttempt(db: Database, workflowId: string, attemptId: string): WorkflowAttemptInspection {
  const attempt = requireAttempt(db, attemptId);
  if (attempt.workflowId !== workflowId) workflowConflict('Attempt belongs to another workflow.');
  const task = readPlan(db, workflowId, attempt.planRevision).plan.tasks.find(task => task.id === attempt.taskId)!;
  const artifacts = db.query<{ payload_json: string }, [string]>('SELECT payload_json FROM artifacts WHERE attempt_id=? ORDER BY id')
    .all(attemptId).map(row => JSON.parse(row.payload_json) as WorkflowArtifact);
  const operations = db.query<WorkflowOperationView, [string]>(`SELECT id,attempt_id AS attemptId,kind,resource_key AS resourceKey,status,
    reconcile_count AS reconcileCount,next_reconcile_at AS nextReconcileAt,json_extract(payload_json,'$.stage') AS stage,
    substr(json_extract(result_json,'$.detail'),1,2048) AS detail FROM operation_intents WHERE attempt_id=? ORDER BY rowid DESC`).all(attemptId);
  const resources = db.query<Omit<WorkflowResourceClaim, 'quarantined' | 'riskReleased' | 'retained'> & {
    quarantined: number; riskReleased: number; retained: number }, [string]>(`SELECT resource_key AS resourceKey,attempt_id AS attemptId,
    executor_id AS executorId,quarantined,risk_released AS riskReleased,retained FROM resource_claims WHERE attempt_id=? ORDER BY resource_key`)
    .all(attemptId).map(claim => ({ ...claim, quarantined: claim.quarantined === 1, riskReleased: claim.riskReleased === 1, retained: claim.retained === 1 }));
  return { attempt, task, artifacts, operations, resources };
}
