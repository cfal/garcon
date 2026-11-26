import type { Database } from 'bun:sqlite';
import type { JsonObject, JsonValue } from '../../../common/json.js';
import type { WorkflowDefinition, WorkflowInput, WorkflowStep } from '../../../common/workflow-definition.js';
import type {
  WorkflowActiveChat, WorkflowAttempt, WorkflowDefinitionSummary, WorkflowExecutionContext, WorkflowInstanceStatus,
  WorkflowLocation, WorkflowPage, WorkflowPageRequest, WorkflowRevision, WorkflowRunAmendment, WorkflowRunArchive, WorkflowRunDetail,
  WorkflowRunStatus, WorkflowRunStep, WorkflowRunSummary, WorkflowSignalOccurrence, WorkflowSignalSource,
  WorkflowStepInstance, WorkflowStepSettings, WorkflowTrigger,
} from '../../../common/workflow-runs.js';
import { workflowConflict, workflowInvalid, workflowLimit, workflowNotFound } from './errors.js';
import { WORKFLOW_LIMITS } from './limits.js';
import { normalizePage } from './requests.js';

interface RevisionRow {
  definition_id: string;
  revision: number;
  source: string;
  definition_json: string;
  published_at: string;
}

export interface RunRow {
  id: string;
  name: string;
  definition_id: string | null;
  revision: number | null;
  draft_json: string | null;
  inputs_json: string;
  context_json: string;
  status: Exclude<WorkflowRunStatus, 'archived'>;
  archive_json: string | null;
  created_at: string;
  updated_at: string;
  signal_bytes: number;
  binding_bytes: number;
}

type RunSummaryRow = Pick<RunRow, 'id' | 'name' | 'definition_id' | 'revision' | 'status' | 'archive_json' | 'created_at' | 'updated_at'>;
const RUN_SUMMARY_COLUMNS = 'id, name, definition_id, revision, status, archive_json, created_at, updated_at';

export interface RunStepRow {
  id: string;
  run_id: string;
  step_json: string;
  location_json: string | null;
  settings_json: string | null;
  intake: 'open' | 'closed' | 'skipped' | 'blocked';
  reason: string | null;
  close_sequence: number | null;
  added: number;
}

export interface InstanceRow {
  id: string;
  run_id: string;
  step_id: string;
  key: string | null;
  trigger_json: string;
  status: WorkflowInstanceStatus;
  reason: string | null;
  bindings_json: string | null;
  prompt: string | null;
  attempt_count: number;
}

export interface AttemptRow {
  id: string;
  instance_id: string;
  number: number;
  status: WorkflowAttempt['status'];
  chat_id: string | null;
  turn_id: string | null;
  chat_confirmed: number;
  chat_removed: number;
  started_at: string;
  finished_at: string | null;
  reason: string | null;
  diagnostic: string | null;
}

export interface SignalRow {
  sequence: number;
  id: string;
  run_id: string;
  step_id: string;
  instance_id: string | null;
  signal: string;
  key: string;
  payload_json: string | null;
  source_json: string;
  created_at: string;
}

export function revisionByNumber(db: Database, id: string, revision: number): WorkflowRevision | null {
  const row = db.query<RevisionRow, [string, number]>(
    'SELECT * FROM workflow_revisions WHERE definition_id = ? AND revision = ?',
  ).get(id, revision);
  return row ? {
    definitionId: row.definition_id, revision: row.revision, source: row.source,
    definition: JSON.parse(row.definition_json) as WorkflowDefinition, publishedAt: row.published_at,
  } : null;
}

export function revisionHead(db: Database, id: string): { latest_revision: number; deleted: number } | null {
  return db.query<{ latest_revision: number; deleted: number }, [string]>(
    'SELECT latest_revision, deleted FROM workflow_definitions WHERE id = ?',
  ).get(id);
}

export function listDefinitions(db: Database, request: WorkflowPageRequest): WorkflowPage<WorkflowDefinitionSummary> {
  const { limit, cursor } = normalizePage(request, WORKFLOW_LIMITS.definitionsPage);
  const rows = db.query<{
    id: string; revision: number; published_at: string; name: string; description: string | null; inputs: string;
  }, [string, number]>(`
    SELECT d.id, r.revision, r.published_at, json_extract(r.definition_json, '$.name') AS name,
      json_extract(r.definition_json, '$.description') AS description, json_extract(r.definition_json, '$.inputs') AS inputs
    FROM workflow_definitions d JOIN workflow_revisions r ON r.definition_id = d.id AND r.revision = d.latest_revision
    WHERE d.deleted = 0 AND d.id > ? ORDER BY d.id LIMIT ?
  `).all(cursor ?? '', limit + 1);
  const items = rows.slice(0, limit).map(row => ({
    id: row.id, revision: row.revision, publishedAt: row.published_at, name: row.name,
    ...(row.description !== null && { description: row.description }),
    inputs: JSON.parse(row.inputs) as Readonly<Record<string, WorkflowInput>>,
  }));
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}

export function runSummary(row: RunSummaryRow): WorkflowRunSummary {
  return {
    id: row.id, name: row.name, kind: row.definition_id === null ? 'test' : 'published',
    definitionId: row.definition_id, revision: row.revision, status: row.archive_json === null ? row.status : 'archived',
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function replayLaunch(db: Database, operationId: string, fingerprint: string): WorkflowRunSummary | null {
  const row = db.query<RunSummaryRow & { request_hash: string }, [string]>(
    `SELECT ${RUN_SUMMARY_COLUMNS}, request_hash FROM workflow_runs WHERE operation_id = ?`,
  ).get(operationId);
  if (row && row.request_hash !== fingerprint) throw workflowConflict('This operation id was already used for a different launch.');
  return row && runSummary(row);
}

export function listRuns(db: Database, request: WorkflowPageRequest): WorkflowPage<WorkflowRunSummary> {
  const { limit, cursor } = normalizePage(request, WORKFLOW_LIMITS.runsPage);
  const before = cursor === null ? Number.MAX_SAFE_INTEGER : Number(cursor);
  if (!Number.isSafeInteger(before) || before < 1) throw workflowInvalid('Invalid workflow run page cursor.');
  const rows = db.query<RunSummaryRow & { sequence: number }, [number, number]>(`
    SELECT rowid AS sequence, ${RUN_SUMMARY_COLUMNS}
    FROM workflow_runs WHERE rowid < ? ORDER BY rowid DESC LIMIT ?
  `).all(before, limit + 1);
  return { items: rows.slice(0, limit).map(runSummary), nextCursor: rows.length > limit ? String(rows[limit - 1]!.sequence) : null };
}

export function requireRun(db: Database, id: string): RunRow {
  const row = db.query<RunRow, [string]>('SELECT * FROM workflow_runs WHERE id = ?').get(id);
  if (!row) throw workflowNotFound('Workflow run');
  return row;
}

export function requireUnarchivedRun(db: Database, id: string): RunRow {
  const run = requireRun(db, id);
  if (run.archive_json !== null) throw workflowConflict('This workflow run is archived.');
  return run;
}

export function pinnedRevision(db: Database, run: RunRow): WorkflowRevision {
  if (run.draft_json !== null) return JSON.parse(run.draft_json) as WorkflowRevision;
  return revisionByNumber(db, run.definition_id!, run.revision!)!;
}

export function runSteps(db: Database, runId: string): RunStepRow[] {
  return db.query<RunStepRow, [string]>('SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY rowid').all(runId);
}

export function requireStep(db: Database, runId: string, stepId: string): WorkflowStep {
  const row = db.query<Pick<RunStepRow, 'step_json'>, [string, string]>(
    'SELECT step_json FROM workflow_run_steps WHERE run_id = ? AND id = ?',
  ).get(runId, stepId);
  if (!row) throw workflowNotFound('Workflow step');
  return JSON.parse(row.step_json) as WorkflowStep;
}

export function requireInstance(db: Database, runId: string, instanceId: string): InstanceRow {
  const row = db.query<InstanceRow, [string, string]>('SELECT * FROM workflow_instances WHERE run_id = ? AND id = ?').get(runId, instanceId);
  if (!row) throw workflowNotFound('Workflow step instance');
  return row;
}

export function signalById(db: Database, runId: string, id: string): SignalRow {
  const row = db.query<SignalRow, [string, string]>('SELECT * FROM workflow_signals WHERE id = ? AND run_id = ?').get(id, runId);
  if (!row) throw workflowNotFound('Signal occurrence');
  return row;
}

export function signalOccurrence(row: SignalRow): WorkflowSignalOccurrence {
  return {
    id: row.id, runId: row.run_id, ref: { stepId: row.step_id, signal: row.signal },
    instanceId: row.instance_id, key: row.key || null,
    ...(row.payload_json !== null && { payload: JSON.parse(row.payload_json) as JsonValue }),
    source: JSON.parse(row.source_json) as WorkflowSignalSource, createdAt: row.created_at,
  };
}

function attemptFromRow(row: AttemptRow, hasChat?: (chatId: string) => boolean): WorkflowAttempt {
  const chatId = row.chat_confirmed ? row.chat_id : null;
  return { id: row.id, number: row.number, status: row.status, chatId, turnId: row.chat_confirmed ? row.turn_id : null,
    chatAvailable: chatId !== null && row.chat_removed === 0 && (hasChat?.(chatId) ?? true),
    startedAt: row.started_at, finishedAt: row.finished_at, reason: row.reason, diagnostic: row.diagnostic ?? null };
}

export function runDetail(db: Database, runId: string, hasChat?: (chatId: string) => boolean): WorkflowRunDetail {
  const run = requireRun(db, runId);
  const instances = Map.groupBy(db.query<InstanceRow, [string]>(
    'SELECT * FROM workflow_instances WHERE run_id = ? ORDER BY rowid',
  ).all(runId), row => row.step_id);
  const attempts = Map.groupBy(db.query<AttemptRow, [string]>(`
    SELECT a.* FROM workflow_instances i JOIN workflow_attempts a ON a.instance_id = i.id
    WHERE i.run_id = ? ORDER BY a.number
  `).all(runId), row => row.instance_id);
  const steps: WorkflowRunStep[] = runSteps(db, runId).map(row => ({
    step: JSON.parse(row.step_json) as WorkflowStep,
    location: row.location_json === null ? null : JSON.parse(row.location_json) as WorkflowLocation,
    settings: row.settings_json === null ? null : JSON.parse(row.settings_json) as WorkflowStepSettings,
    intake: row.intake === 'open' ? 'open' : 'closed',
    waitingReason: row.reason,
    instances: (instances.get(row.id) ?? []).map((item): WorkflowStepInstance => ({
      id: item.id, key: item.key, status: item.status, trigger: JSON.parse(item.trigger_json) as WorkflowTrigger,
      bindings: item.bindings_json === null ? null : JSON.parse(item.bindings_json) as JsonObject,
      prompt: item.prompt, reason: item.reason, attempts: (attempts.get(item.id) ?? []).map(row => attemptFromRow(row, hasChat)),
    })),
  }));
  const signals = db.query<SignalRow, [string]>('SELECT * FROM workflow_signals WHERE run_id = ? ORDER BY sequence').all(runId);
  const amendments = db.query<{ amendment_json: string }, [string]>(`
    SELECT amendment_json FROM workflow_operations WHERE run_id = ? AND amendment_json IS NOT NULL ORDER BY rowid
  `).all(runId);
  return { ...runSummary(run), pinnedRevision: pinnedRevision(db, run),
    archive: run.archive_json === null ? null : JSON.parse(run.archive_json) as WorkflowRunArchive,
    inputs: JSON.parse(run.inputs_json) as JsonObject, executionContext: JSON.parse(run.context_json) as WorkflowExecutionContext,
    steps, signals: signals.map(signalOccurrence), amendments: amendments.map(row => JSON.parse(row.amendment_json) as WorkflowRunAmendment) };
}

export function listActiveChats(db: Database, request: WorkflowPageRequest, hasChat?: (chatId: string) => boolean): WorkflowPage<WorkflowActiveChat> {
  const { limit, cursor } = normalizePage(request, WORKFLOW_LIMITS.activeChatsPage);
  const candidates = db.query<WorkflowActiveChat, [string, number]>(`
    SELECT a.chat_id AS chatId, i.run_id AS runId, i.step_id AS stepId, i.id AS instanceId, a.id AS attemptId,
      a.status, r.name AS runName, r.status AS runStatus, r.updated_at AS runUpdatedAt
    FROM workflow_attempts a JOIN workflow_instances i ON i.id = a.instance_id JOIN workflow_runs r ON r.id = i.run_id
    WHERE a.chat_confirmed = 1 AND a.chat_id IS NOT NULL AND a.chat_removed = 0 AND a.status IN ('running','failed','unknown')
      AND r.archive_json IS NULL AND a.number = i.attempt_count AND a.status = i.status AND a.chat_id > ?
    ORDER BY a.chat_id LIMIT ?
  `);
  const rows: WorkflowActiveChat[] = [];
  let after = cursor ?? '';
  do {
    const batch = candidates.all(after, limit + 1);
    for (const row of batch) {
      if (hasChat && !hasChat(row.chatId)) continue;
      rows.push(row);
      if (rows.length > limit) break;
    }
    if (batch.length <= limit) break;
    // The registry is not in SQLite. Skip missing chats without consuming a visible slot or cursor.
    after = batch.at(-1)!.chatId;
  } while (rows.length <= limit);
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.chatId : null };
}

export function priorOperation(db: Database, runId: string, operationId: string, fingerprint: string): string | null {
  const row = db.query<{ request_hash: string; result_id: string }, [string, string]>(
    'SELECT request_hash, result_id FROM workflow_operations WHERE run_id = ? AND id = ?',
  ).get(runId, operationId);
  if (row && row.request_hash !== fingerprint) throw workflowConflict('This operation id was already used for a different request.');
  return row?.result_id ?? null;
}

export function saveOperation(
  db: Database, runId: string, operationId: string, fingerprint: string, resultId: string, amendment?: WorkflowRunAmendment,
): void {
  const { count } = db.query<{ count: number }, [string]>('SELECT count(*) AS count FROM workflow_operations WHERE run_id = ?').get(runId)!;
  if (count >= WORKFLOW_LIMITS.operations) throw workflowLimit('This run has reached its operation limit.');
  db.query('INSERT INTO workflow_operations VALUES (?, ?, ?, ?, ?)').run(
    runId, operationId, fingerprint, resultId, amendment === undefined ? null : JSON.stringify(amendment),
  );
}

export function referencesTarget(db: Database, column: 'executor_id' | 'provider_id', id: string): boolean {
  return db.query(`
    SELECT 1 FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id
    WHERE s.${column} = ? AND r.archive_json IS NULL AND (
      s.intake = 'open' OR EXISTS (
        SELECT 1 FROM workflow_instances i WHERE i.run_id = s.run_id AND i.step_id = s.id
          AND i.status IN ('ready', 'running', 'waiting-executor', 'failed', 'unknown')
      )
    ) LIMIT 1
  `).get(id) !== null;
}
