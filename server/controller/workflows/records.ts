import type { Database } from 'bun:sqlite';
import { parseWorkflowPlan, parseWorkflowRepository } from '../../../common/workflow-validation.js';
import type { WorkflowActivity, WorkflowApproval, WorkflowApprovalManifest, WorkflowArtifact, WorkflowAttempt,
  WorkflowDetail, WorkflowPlanRevision, WorkflowRecord, WorkflowTaskRecord } from '../../../common/workflows.js';
import { DomainError } from '../../common/domain-error.js';
import { workflowDigest } from './inputs.js';
import { projectWorkflowTasks, workflowOutcome } from './transitions.js';

const WORKFLOW_COLUMNS = `id,revision,desired,draft_plan_revision AS draftPlanRevision,
  active_plan_revision AS activePlanRevision,admission_epoch AS admissionEpoch,control_epoch AS controlEpoch,
  title,captain_chat_id AS captainChatId,archived,created_at AS createdAt,updated_at AS updatedAt`;

export function requireWorkflow(database: Database, id: string): WorkflowRecord {
  const row = database.query<Omit<WorkflowRecord, 'archived'> & { archived: number }, [string]>(`SELECT ${WORKFLOW_COLUMNS} FROM workflows WHERE id=?`).get(id);
  if (!row) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not found.', 404);
  return { ...row, archived: row.archived === 1 };
}
export function listWorkflowRecords(database: Database, after: string | null, limit: number): WorkflowRecord[] {
  return database.query<{ id: string }, [string | null, string | null, number]>(
    'SELECT id FROM workflows WHERE archived=0 AND (? IS NULL OR id>?) ORDER BY id LIMIT ?',
  ).all(after, after, limit).map(row => requireWorkflow(database, row.id));
}
export function readPlan(database: Database, workflowId: string, revision: number): WorkflowPlanRevision {
  const row = database.query<{ digest: string; plan_json: string }, [string, number]>(
    'SELECT digest,plan_json FROM plan_revisions WHERE workflow_id=? AND revision=?',
  ).get(workflowId, revision);
  if (!row) throw new Error('Missing workflow plan revision.');
  const plan = parseWorkflowPlan(JSON.parse(row.plan_json));
  if (workflowDigest(plan) !== row.digest) throw new Error('Workflow plan digest mismatch.');
  return { revision, digest: row.digest, plan };
}
export function readTasks(database: Database, workflowId: string): WorkflowTaskRecord[] {
  return database.query<WorkflowTaskRecord, [string]>(`SELECT workflow_id AS workflowId,id,generation,
    input_digest AS inputDigest,hold,hold_reason AS holdReason,next_eligible_at AS nextEligibleAt
    FROM tasks WHERE workflow_id=? ORDER BY id`).all(workflowId);
}
type AttemptRow = Omit<WorkflowAttempt, 'target' | 'result'> & { target_json: string; result_json: string | null };
const ATTEMPT_COLUMNS = `id AS attemptId,workflow_id AS workflowId,task_id AS taskId,plan_revision AS planRevision,generation,
  input_digest AS inputDigest,dispatch_phase AS dispatchPhase,resolution,control_state AS controlState,
  revocation_reason AS revocationReason,request_id AS requestId,server_instance_id AS serverInstanceId,
  chat_id AS chatId,turn_id AS turnId,target_json,result_json,created_at AS createdAt`;
function decodeAttempt(row: AttemptRow): WorkflowAttempt {
  const { target_json, result_json, ...identity } = row;
  const target = JSON.parse(target_json);
  return { ...identity, target: target === null ? null : parseWorkflowRepository(target), result: result_json === null ? null : JSON.parse(result_json) };
}
export function readAttempts(database: Database, workflowId: string): WorkflowAttempt[] {
  return database.query<AttemptRow, [string]>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE workflow_id=?
    AND (resolution IN ('open','unknown') OR generation=(SELECT generation FROM tasks t WHERE t.workflow_id=attempts.workflow_id AND t.id=attempts.task_id))
    ORDER BY rowid`).all(workflowId).map(decodeAttempt);
}
export function readAttemptHistory(database: Database, workflowId: string, before: string | null, limit: number): WorkflowAttempt[] {
  if (before !== null && requireAttempt(database, before).workflowId !== workflowId) throw new DomainError('WORKFLOW_CONFLICT', 'Attempt cursor belongs to another workflow.', 409);
  return database.query<AttemptRow, [string, string | null, string | null, number]>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts
    WHERE workflow_id=? AND (? IS NULL OR rowid<(SELECT rowid FROM attempts WHERE id=?)) ORDER BY rowid DESC LIMIT ?`)
    .all(workflowId, before, before, limit).map(decodeAttempt);
}
export function requireAttempt(database: Database, id: string): WorkflowAttempt {
  const row = database.query<AttemptRow, [string]>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id=?`).get(id);
  if (!row) throw new DomainError('WORKFLOW_NOT_FOUND', 'Attempt not found.', 404);
  return decodeAttempt(row);
}
export function readArtifacts(database: Database, workflowId: string): WorkflowArtifact[] {
  return database.query<{ payload_json: string }, [string]>(`SELECT r.payload_json FROM artifacts r
    JOIN attempts a ON a.id=r.attempt_id JOIN tasks t ON t.workflow_id=a.workflow_id AND t.id=a.task_id
    WHERE a.workflow_id=? AND a.generation=t.generation ORDER BY r.id LIMIT 1024`).all(workflowId).map(row => JSON.parse(row.payload_json));
}
export function readApprovals(database: Database, workflowId: string): WorkflowApproval[] {
  return database.query<{ payload_json: string }, [string]>(`SELECT a.payload_json FROM approvals a JOIN gate_manifests g
    ON g.workflow_id=a.workflow_id AND g.gate_id=a.gate_id AND g.manifest_digest=a.manifest_digest WHERE a.workflow_id=?`).all(workflowId).map(row => JSON.parse(row.payload_json));
}
export function readGateManifests(database: Database, workflowId: string): { manifest: WorkflowApprovalManifest; digest: string }[] {
  return database.query<{ payload_json: string; manifest_digest: string }, [string]>(
    'SELECT payload_json,manifest_digest FROM gate_manifests WHERE workflow_id=? ORDER BY gate_id',
  ).all(workflowId).map(row => {
    const manifest: WorkflowApprovalManifest = JSON.parse(row.payload_json);
    if (workflowDigest(manifest) !== row.manifest_digest) throw new Error('Invalid approval manifest.');
    return { manifest, digest: row.manifest_digest };
  });
}
export function activationManifest(plan: WorkflowPlanRevision): WorkflowApprovalManifest {
  return { gateId: 'activation', planRevision: plan.revision, planDigest: plan.digest,
    taskId: null, generation: null, artifacts: [], publication: null };
}
export function workflowEpoch(database: Database): number {
  const row = database.query<{ admission_epoch: number }, []>('SELECT admission_epoch FROM workflow_metadata WHERE singleton=1').get();
  if (!row) throw new Error('Missing workflow epoch.');
  return row.admission_epoch;
}
export function workflowRevision(database: Database): number {
  const row = database.query<{ revision: number }, []>('SELECT revision FROM workflow_metadata WHERE singleton=1').get();
  if (!row) throw new Error('Missing workflow revision.');
  return row.revision;
}
export function readWorkflowDetail(database: Database, id: string): WorkflowDetail {
  const workflow = requireWorkflow(database, id);
  const draft = readPlan(database, id, workflow.draftPlanRevision);
  const active = workflow.activePlanRevision === null ? null : readPlan(database, id, workflow.activePlanRevision);
  const tasks = projectWorkflowTasks(workflow, active?.plan ?? null, readTasks(database, id), readAttempts(database, id), workflowEpoch(database));
  const manifest = activationManifest(draft);
  return { workflow, draft, active, tasks, artifacts: readArtifacts(database, id), approvals: readApprovals(database, id),
    gates: readGateManifests(database, id), outcome: workflowOutcome(active?.plan ?? null, tasks), activationManifest: manifest, activationDigest: workflowDigest(manifest) };
}
export function appendWorkflowActivity(database: Database, workflowId: string, action: string, actor: string, detail: string, at: string): void {
  database.query('INSERT INTO activity (workflow_id,action,actor,detail,at) VALUES (?,?,?,?,?)').run(workflowId, action, actor, detail, at);
  database.query('UPDATE workflows SET revision=revision+1,updated_at=? WHERE id=?').run(at, workflowId);
  database.query('UPDATE workflow_metadata SET revision=revision+1 WHERE singleton=1').run();
}
export function readWorkflowActivity(database: Database, id: string, before: number, limit: number): WorkflowActivity[] {
  requireWorkflow(database, id);
  return database.query<WorkflowActivity, [string, number, number]>(`SELECT sequence,workflow_id AS workflowId,action,actor,detail,at
    FROM activity WHERE workflow_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?`).all(id, before, limit);
}
