import type { Database } from 'bun:sqlite';
import { parseWorkflowPlan, parseWorkflowRepository } from '../../../common/workflow-validation.js';
import { WORKFLOW_LIMITS, type WorkflowActivity, type WorkflowApproval, type WorkflowApprovalManifest, type WorkflowArtifact, type WorkflowAttempt,
  type WorkflowAttemptResult, type WorkflowDetail, type WorkflowPlanRevision, type WorkflowRecord, type WorkflowTaskRecord } from '../../../common/workflows.js';
import { DomainError } from '../../common/domain-error.js';
import { workflowDigest, type WorkflowDependencyArtifact } from './inputs.js';
import { projectWorkflowTasks, workflowOutcome, type WorkflowAttemptStatus, type WorkflowRetryCounts } from './transitions.js';

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
export function listActiveWorkflowIds(database: Database, after: string | null, limit: number): string[] {
  return database.query<{ id: string }, [string | null, string | null, number]>(
    "SELECT id FROM workflows WHERE archived=0 AND desired='active' AND (? IS NULL OR id>?) ORDER BY id LIMIT ?",
  ).all(after, after, limit).map(row => row.id);
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
type AttemptRow = Omit<WorkflowAttempt, 'target' | 'result' | 'effectiveInput' | 'admissionFailure' | 'managedTarget'> & {
  target_json: string; result_json: string | null; effective_input_json: string | null;
  managed_target_json: string | null;
  admissionFailure: number;
};
const ATTEMPT_COLUMNS = `id AS attemptId,workflow_id AS workflowId,task_id AS taskId,plan_revision AS planRevision,generation,
  input_digest AS inputDigest,dispatch_phase AS dispatchPhase,resolution,control_state AS controlState,
  revocation_reason AS revocationReason,revocation_kind AS revocationKind,admission_failure AS admissionFailure,
  request_id AS requestId,server_instance_id AS serverInstanceId,
  chat_id AS chatId,turn_id AS turnId,target_json,result_json,effective_input_json,managed_target_json,created_at AS createdAt`;
function decodeAttempt(row: AttemptRow): WorkflowAttempt {
  const { target_json, result_json, effective_input_json, managed_target_json, ...identity } = row;
  const target = JSON.parse(target_json);
  return { ...identity, admissionFailure: identity.admissionFailure === 1, target: target === null ? null : parseWorkflowRepository(target),
    result: result_json === null ? null : JSON.parse(result_json),
    effectiveInput: effective_input_json === null ? null : JSON.parse(effective_input_json),
    managedTarget: managed_target_json === null ? null : JSON.parse(managed_target_json) };
}
const CURRENT_ATTEMPTS = `workflow_id=? AND (resolution IN ('open','unknown') OR control_state='leased' OR dispatch_phase!='settled' OR rowid IN
  (SELECT MAX(a.rowid) FROM attempts a JOIN tasks t ON t.workflow_id=a.workflow_id AND t.id=a.task_id
    WHERE a.workflow_id=? AND a.generation=t.generation GROUP BY a.task_id))`;

export function readAttempts(database: Database, workflowId: string): WorkflowAttempt[] {
  return database.query<AttemptRow, [string, string]>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts
    WHERE ${CURRENT_ATTEMPTS} ORDER BY rowid`).all(workflowId, workflowId).map(decodeAttempt);
}

function readRetryCounts(database: Database, workflowId: string): ReadonlyMap<string, WorkflowRetryCounts> {
  const rows = database.query<WorkflowRetryCounts & { taskId: string }, [string]>(`SELECT a.task_id AS taskId,
    SUM(a.admission_failure) AS admissions,SUM(a.resolution!='not-started') AS executions
    FROM attempts a JOIN tasks t ON t.workflow_id=a.workflow_id AND t.id=a.task_id AND t.generation=a.generation
    WHERE a.workflow_id=? GROUP BY a.task_id`).all(workflowId);
  return new Map(rows.map(row => [row.taskId, row]));
}

export function readWorkflowSchedule(database: Database, id: string) {
  const workflow = requireWorkflow(database, id);
  const active = workflow.activePlanRevision === null ? null : readPlan(database, id, workflow.activePlanRevision);
  const attempts = database.query<Omit<WorkflowAttemptStatus, 'result'> & {
    certainty: WorkflowAttemptResult['certainty'] | null; termination: WorkflowAttemptResult['termination'] | null }, [string, string]>(`SELECT id AS attemptId,task_id AS taskId,
    generation,input_digest AS inputDigest,resolution,dispatch_phase AS dispatchPhase,control_state AS controlState,
    json_extract(result_json,'$.certainty') AS certainty,json_extract(result_json,'$.termination') AS termination
    FROM attempts WHERE ${CURRENT_ATTEMPTS} ORDER BY rowid`).all(id, id).map(({ certainty, termination, ...attempt }) => ({
      ...attempt, result: certainty && termination ? { certainty, termination } : null,
    }));
  const tasks = projectWorkflowTasks(workflow, active?.plan ?? null, readTasks(database, id), attempts,
    workflowEpoch(database), readRetryCounts(database, id));
  return { workflow, active, tasks };
}
export function readAttemptHistory(database: Database, workflowId: string, before: string | null, limit: number): WorkflowAttempt[] {
  if (before !== null && requireAttempt(database, before).workflowId !== workflowId) throw new DomainError('WORKFLOW_CONFLICT', 'Attempt cursor belongs to another workflow.', 409);
  return database.query<AttemptRow, [string, string | null, string | null, number, number]>(`WITH page AS
    (SELECT rowid AS position,${ATTEMPT_COLUMNS},length(CAST(COALESCE(result_json,'') || COALESCE(effective_input_json,'')
      || COALESCE(managed_target_json,'') || target_json AS BLOB))+2048 AS bytes FROM attempts
      WHERE workflow_id=? AND (? IS NULL OR rowid<(SELECT rowid FROM attempts WHERE id=?)) ORDER BY rowid DESC LIMIT ?)
    SELECT * FROM (SELECT *,SUM(bytes) OVER (ORDER BY position DESC) AS total FROM page) WHERE total<=? ORDER BY position DESC`)
    .all(workflowId, before, before, limit, WORKFLOW_LIMITS.pageBytes).map(row => {
      // SQL-only pagination fields do not cross the public contract.
      const { position: _position, bytes: _bytes, total: _total, ...attempt } = row as AttemptRow & { position: number; bytes: number; total: number };
      return decodeAttempt(attempt);
    });
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
export function readDependencyArtifacts(database: Database, workflowId: string, taskIds: readonly string[]): WorkflowDependencyArtifact[] {
  if (!taskIds.length) return [];
  return database.query<Omit<WorkflowDependencyArtifact, 'attempt' | 'dirty'> & { taskId: string; dirty: number | null }, string[]>(`SELECT r.id,
    json_extract(r.payload_json,'$.digest') AS digest,json_extract(r.payload_json,'$.commit') AS 'commit',a.task_id AS taskId,
    json_extract(r.payload_json,'$.kind') AS kind,json_extract(r.payload_json,'$.outcome') AS outcome,
    json_extract(r.payload_json,'$.provenance') AS provenance,json_extract(r.payload_json,'$.executorId') AS executorId,
    json_extract(r.payload_json,'$.repositoryId') AS repositoryId,json_extract(r.payload_json,'$.dirty') AS dirty
    FROM artifacts r JOIN attempts a ON a.id=r.attempt_id JOIN tasks t ON t.workflow_id=a.workflow_id AND t.id=a.task_id
    WHERE a.workflow_id=? AND a.generation=t.generation AND a.input_digest=t.input_digest AND a.resolution='succeeded'
    AND a.control_state='released' AND a.dispatch_phase='settled'
    AND t.hold='none' AND a.task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY r.id`)
    .all(workflowId, ...taskIds).map(({ taskId, dirty, ...artifact }) => ({ ...artifact, dirty: dirty === null ? null : dirty === 1, attempt: { taskId } }));
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
  const tasks = projectWorkflowTasks(workflow, active?.plan ?? null, readTasks(database, id), readAttempts(database, id), workflowEpoch(database), readRetryCounts(database, id));
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
