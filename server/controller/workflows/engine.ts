import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { isExecutorId } from '../../../common/executors.js';
import type { JsonObject } from '../../../common/json.js';
import {
  getWorkflowStepSignal, parseWorkflowStepAddition, WORKFLOW_TURN_COMPLETED, type WorkflowAgentStep, type WorkflowDefinition, type WorkflowStep,
} from '../../../common/workflow-definition.js';
import type {
  WorkflowActiveChat, WorkflowActor, WorkflowAgentSettings, WorkflowDefinitionSummary, WorkflowExecutionContext,
  WorkflowLocation, WorkflowPage, WorkflowPageRequest, WorkflowRevision, WorkflowRunAmendment, WorkflowRunArchive, WorkflowRunDetail,
  WorkflowRunSummary, WorkflowSignalOccurrence,
} from '../../../common/workflow-runs.js';
import { DomainError } from '../../common/domain-error.js';
import { diagnosticErrorCode } from '../../common/errors.js';
import { createLogger } from '../../common/log.js';
import type { RetainProviderReferences } from '../api-providers/reference-writes.js';
import type { RetainExecutorReferences } from '../executors/reference-writes.js';
import { captureInputs, captureLocation, captureSettings, validateSignal, wrapCommandWithBindings } from './bindings.js';
import { workflowConflict, workflowInvalid, workflowNotFound, workflowLimit } from './errors.js';
import { WorkflowGraph, type CapturedStep } from './graph.js';
import { WORKFLOW_LIMITS } from './limits.js';
import {
  listActiveChats, listDefinitions, listRuns, pinnedRevision, priorOperation, referencesTarget, replayLaunch, requireInstance,
  requireRun, requireStep, requireUnarchivedRun, revisionByNumber, revisionHead, runDetail, runSteps, runSummary, saveOperation,
  signalById, signalOccurrence, type AttemptRow, type InstanceRow,
} from './records.js';
import {
  normalizeActor, normalizeAddItem, normalizeAddStep, normalizeArchive, normalizeDecision, normalizePublish, normalizeRetry,
  mergeExecutionContext, normalizeStart, normalizeStop, normalizeTest, requestHash, workflowIdentifier, workflowJson,
} from './requests.js';
import type { WorkflowAttemptRequest, WorkflowAttemptResult, WorkflowEmitRequest, WorkflowRunner } from './runner.js';
import type { WorkflowStore } from './store.js';

const logger = createLogger('workflow-engine');
const UNKNOWN_OUTCOME = 'The exact turn outcome could not be confirmed.';
const REMOVED_CHAT_OUTCOME = 'The attempt chat was removed before its exact turn settled.';
const RECOVERY_BATCH = 32;

export type WorkflowSettingsResolver = (step: WorkflowAgentStep, location: WorkflowLocation) => WorkflowAgentSettings;

export interface WorkflowEngineOptions {
  readonly store: WorkflowStore;
  readonly runner: WorkflowRunner;
  readonly maxConcurrent?: number;
  readonly now?: () => number;
  readonly snapshotAgentSettings?: WorkflowSettingsResolver;
  readonly retainExecutorReferences?: RetainExecutorReferences;
  readonly retainProviderReferences?: RetainProviderReferences;
  readonly hasChat?: (chatId: string) => boolean;
}

type CurrentAttempt = AttemptRow & { run_id: string; step_id: string; attempt_count: number };

function unfinishedAttempt(row: CurrentAttempt, reason: string): Extract<WorkflowAttemptResult, { reason: string }> {
  // The runner cannot submit a turn until its chat reservation commits.
  if (row.chat_id === null) return { kind: 'failed', reason: 'The attempt ended before a chat was reserved. No turn was started.' };
  return { kind: 'unknown', reason };
}

function currentAttempt(db: Database, id: string): CurrentAttempt | null {
  return db.query<CurrentAttempt, [string]>(`
    SELECT a.*, i.run_id, i.step_id, i.attempt_count
    FROM workflow_attempts a JOIN workflow_instances i ON i.id = a.instance_id
    WHERE a.id = ? AND a.status = 'running' AND i.status = 'running' AND i.attempt_count = a.number
  `).get(id);
}

function finishAttempt(
  db: Database,
  row: CurrentAttempt,
  status: Exclude<AttemptRow['status'], 'running'>,
  reason: string | null,
  now: string,
  diagnostic: string | null = null,
): void {
  // Readiness can flap indefinitely. A refusal before chat reservation is a wait, not an execution attempt.
  if (status === 'unavailable' && row.chat_id === null) {
    db.query('DELETE FROM workflow_attempts WHERE id = ?').run(row.id);
    db.query("UPDATE workflow_instances SET status = 'waiting-executor', reason = ?, attempt_count = attempt_count - 1 WHERE id = ?")
      .run(reason, row.instance_id);
    return;
  }
  db.query('UPDATE workflow_attempts SET status = ?, reason = ?, diagnostic = ?, finished_at = ? WHERE id = ?')
    .run(status, reason, diagnostic, now, row.id);
  const update = db.query('UPDATE workflow_instances SET status = ?, reason = ? WHERE id = ?');
  if (status !== 'unavailable') {
    update.run(status, reason, row.instance_id);
  } else if (row.attempt_count < WORKFLOW_LIMITS.attemptsPerInstance) {
    update.run('waiting-executor', reason, row.instance_id);
  } else {
    update.run('failed', 'Executor unavailable; attempt limit reached.', row.instance_id);
  }
}

type RunningAttempt = {
  readonly runId: string;
  readonly instanceId: string;
  readonly shutdown: AbortController;
  readonly stop: AbortController;
};

export class WorkflowEngine {
  readonly #store: WorkflowStore;
  readonly #maxConcurrent: number;
  readonly #running = new Map<string, RunningAttempt>();
  readonly #readyExecutors = new Map<string, number>();
  #availabilityGeneration = 0;
  #scheduled: ReturnType<typeof setImmediate> | null = null;
  #starting: Promise<void> | null = null;
  #ready = false;
  #stopped = false;
  #closed = false;

  constructor(private readonly options: WorkflowEngineOptions) {
    this.#store = options.store;
    this.#maxConcurrent = options.maxConcurrent ?? 4;
    if (!Number.isSafeInteger(this.#maxConcurrent) || this.#maxConcurrent < 1 || this.#maxConcurrent > WORKFLOW_LIMITS.globalAttempts) {
      throw workflowInvalid(`Workflow concurrency must be between 1 and ${WORKFLOW_LIMITS.globalAttempts}.`);
    }
  }

  start(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return this.#starting ??= this.#recover().then(() => {
      if (this.#stopped) return;
      this.#ready = true;
      this.#wake();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.stop();
    this.#closed = true;
    this.#store.close();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#ready = false;
    if (this.#scheduled) clearImmediate(this.#scheduled);
    this.#scheduled = null;
    for (const entry of this.#running.values()) entry.shutdown.abort();
  }

  wakeExecutor(executorId: string): void {
    if (this.#stopped || !isExecutorId(executorId)) return;
    this.#readyExecutors.set(executorId, ++this.#availabilityGeneration);
    this.#wake();
  }

  publish(raw: unknown, definition: WorkflowDefinition): WorkflowRevision {
    const { definitionId, expectedRevision, source } = normalizePublish(raw);
    return this.#store.write(db => {
      const head = revisionHead(db, definitionId);
      if (head?.deleted || (head?.latest_revision ?? null) !== expectedRevision) {
        throw workflowConflict('The published workflow changed. Reload it before publishing.');
      }
      const revision = (head?.latest_revision ?? 0) + 1;
      const publishedAt = this.#now();
      if (head === null) db.query('INSERT INTO workflow_definitions (id, latest_revision) VALUES (?, ?)').run(definitionId, revision);
      else db.query('UPDATE workflow_definitions SET latest_revision = ? WHERE id = ?').run(revision, definitionId);
      db.query('INSERT INTO workflow_revisions VALUES (?, ?, ?, ?, ?)').run(
        definitionId, revision, source, JSON.stringify(definition), publishedAt,
      );
      return revisionByNumber(db, definitionId, revision)!;
    });
  }

  deleteDefinition(definitionId: string, expectedRevision: number): void {
    this.#store.write(db => {
      const head = revisionHead(db, workflowIdentifier(definitionId, 'Definition id'));
      if (!head || head.deleted) throw workflowNotFound('Workflow definition');
      if (head.latest_revision !== expectedRevision) throw workflowConflict('The published workflow changed. Reload it before deleting.');
      db.query('UPDATE workflow_definitions SET deleted = 1 WHERE id = ?').run(definitionId);
    });
  }

  listDefinitions(request: WorkflowPageRequest = {}): WorkflowPage<WorkflowDefinitionSummary> {
    return this.#store.read(db => listDefinitions(db, request));
  }

  getRevision(definitionId: string, revision?: number): WorkflowRevision {
    return this.#store.read(db => {
      const head = revisionHead(db, workflowIdentifier(definitionId, 'Definition id'));
      if (!head || head.deleted) throw workflowNotFound('Workflow definition');
      const result = revisionByNumber(db, definitionId, revision ?? head.latest_revision);
      if (!result) throw workflowNotFound('Workflow revision');
      return result;
    });
  }

  replayStartRun(raw: unknown): WorkflowRunSummary | null {
    const request = normalizeStart(raw);
    return this.#replayLaunch(request.operationId, requestHash('start', request));
  }

  replayTestWorkflowDraft(raw: unknown): WorkflowRunSummary | null {
    const request = normalizeTest(raw);
    return this.#replayLaunch(request.operationId, requestHash('test', request));
  }

  startRun(
    raw: unknown, snapshot?: WorkflowSettingsResolver, preparedRevision?: Pick<WorkflowRevision, 'definitionId' | 'revision'>,
  ): WorkflowRunSummary {
    const request = normalizeStart(raw);
    return this.#launch(request, requestHash('start', request), () => {
      if (!preparedRevision) return this.getRevision(request.definitionId, request.revision);
      const { definitionId, revision } = preparedRevision;
      if (definitionId !== request.definitionId || revision === null || request.revision !== undefined && request.revision !== revision) {
        throw workflowConflict('The prepared revision does not match this workflow launch.');
      }
      return this.getRevision(definitionId, revision);
    }, snapshot);
  }

  testWorkflowDraft(raw: unknown, definition: WorkflowDefinition, snapshot?: WorkflowSettingsResolver): WorkflowRunSummary {
    const request = normalizeTest(raw);
    return this.#launch(request, requestHash('test', request), () => ({
      definitionId: null, revision: null, source: request.source, definition, publishedAt: null,
    }), snapshot);
  }

  #replayLaunch(operationId: string | undefined, hash: string): WorkflowRunSummary | null {
    return operationId ? this.#store.read(db => replayLaunch(db, operationId, hash)) : null;
  }

  #launch(
    request: { operationId?: string; inputs: JsonObject; executionContext?: WorkflowExecutionContext },
    hash: string,
    revision: () => WorkflowRevision,
    snapshot?: WorkflowSettingsResolver,
  ): WorkflowRunSummary {
    const prior = this.#replayLaunch(request.operationId, hash);
    if (prior) return prior;
    const pinned = revision();
    const inputs = captureInputs(pinned.definition, request.inputs);
    const context = request.executionContext ?? {};
    const steps = pinned.definition.steps.map(step => this.#captureStep(step, context, snapshot));
    const id = randomUUID();
    const now = this.#now();
    const result = this.#withReferences(steps, () => this.#store.write(db => {
      const replay = request.operationId && replayLaunch(db, request.operationId, hash);
      if (replay) return replay;
      db.query(`INSERT INTO workflow_runs (
        id, name, definition_id, revision, draft_json, inputs_json, context_json, status, created_at, updated_at, operation_id, request_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?)`).run(
        id, pinned.definition.name, pinned.definitionId, pinned.revision, pinned.revision === null ? JSON.stringify(pinned) : null,
        inputs, JSON.stringify(context), now, now, request.operationId ?? null, request.operationId ? hash : null,
      );
      const graph = new WorkflowGraph(db, id, now);
      for (const step of steps) graph.insertStep(step);
      graph.reconcile();
      return runSummary(requireRun(db, id));
    }));
    if (result.id === id) this.#wake();
    return result;
  }

  listRuns(request: WorkflowPageRequest = {}): WorkflowPage<WorkflowRunSummary> {
    return this.#store.read(db => listRuns(db, request));
  }

  getRun(runId: string): WorkflowRunDetail {
    return this.#store.read(db => runDetail(db, workflowIdentifier(runId, 'Run id'), this.options.hasChat));
  }

  listActiveChats(request: WorkflowPageRequest = {}): WorkflowPage<WorkflowActiveChat> {
    return this.#store.read(db => listActiveChats(db, request, this.options.hasChat));
  }

  archiveRun(raw: unknown, caller: WorkflowActor): WorkflowRunSummary {
    const request = normalizeArchive(raw);
    const actor = normalizeActor(caller);
    const { runId, operationId } = request;
    const hash = requestHash('archive', request, actor);
    const result = this.#store.write(db => {
      const run = requireRun(db, runId);
      if (priorOperation(db, runId, operationId, hash) || run.archive_json !== null) {
        return { run: runSummary(run), changed: false };
      }
      if (db.query("SELECT 1 FROM workflow_instances WHERE run_id = ? AND status = 'running' LIMIT 1").get(runId)) {
        throw workflowConflict('A live workflow attempt must settle before the run can be archived.');
      }
      const archive: WorkflowRunArchive = { operationId, actor, createdAt: this.#now() };
      db.query('UPDATE workflow_runs SET archive_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(archive), archive.createdAt, runId);
      db.query("UPDATE workflow_instances SET retired = 1 WHERE run_id = ? AND status IN ('ready', 'waiting-executor')").run(runId);
      // Archiving remains available even when the run has reached its normal operation limit.
      db.query('INSERT INTO workflow_operations (run_id, id, request_hash, result_id) VALUES (?, ?, ?, ?)').run(runId, operationId, hash, runId);
      return { run: runSummary(requireRun(db, runId)), changed: true };
    });
    if (result.changed) this.#wake();
    return result.run;
  }

  referencesExecutor(id: string): boolean { return this.#references('executor_id', id); }
  referencesApiProvider(id: string): boolean { return this.#references('provider_id', id); }

  #references(column: 'executor_id' | 'provider_id', id: string): boolean {
    try { return this.#store.read(db => referencesTarget(db, column, id)); }
    catch { return true; }
  }

  #withReferences<T>(steps: readonly CapturedStep[], action: () => T): T {
    const releaseExecutors = this.options.retainExecutorReferences?.(steps.map(step => step.location?.executorId));
    try {
      const releaseProviders = this.options.retainProviderReferences?.(
        steps.map(step => step.settings?.kind === 'agent' ? step.settings.apiProviderId : null),
      );
      try { return action(); } finally { releaseProviders?.(); }
    } finally { releaseExecutors?.(); }
  }

  decide(raw: unknown, caller: WorkflowActor): WorkflowSignalOccurrence {
    const request = normalizeDecision(raw);
    const actor = normalizeActor(caller);
    const hash = requestHash('decide', request, actor);
    const { runId, instanceId, operationId, choice } = request;
    const result = this.#store.write(db => {
      const prior = priorOperation(db, runId, operationId, hash);
      if (prior) return signalOccurrence(signalById(db, runId, prior));
      requireUnarchivedRun(db, runId);
      const instance = requireInstance(db, runId, instanceId);
      const step = requireStep(db, runId, instance.step_id);
      if (step.kind !== 'decision' || !Object.hasOwn(step.choices, choice)) throw workflowInvalid('That choice is not defined for this decision.');
      if (instance.status !== 'awaiting-decision') throw workflowConflict('This decision is no longer open.');
      db.query("UPDATE workflow_instances SET status = 'succeeded', reason = NULL WHERE id = ?").run(instanceId);
      const graph = new WorkflowGraph(db, runId, this.#now());
      const { row } = graph.emit({
        ref: { stepId: step.id, signal: choice }, instanceId, scope: instanceId, key: '', payloadJson: null,
        source: { kind: 'decision', actor, operationId },
      });
      graph.reconcile();
      saveOperation(db, runId, operationId, hash, row.id);
      return signalOccurrence(row);
    });
    this.#wake();
    return result;
  }

  addItem(raw: unknown, caller: WorkflowActor): WorkflowSignalOccurrence {
    const request = normalizeAddItem(raw);
    const actor = normalizeActor(caller);
    const hash = requestHash('add-item', request, actor);
    const { runId, stepId, operationId, key, payload } = request;
    const result = this.#store.write(db => {
      const prior = priorOperation(db, runId, operationId, hash);
      if (prior) return signalOccurrence(signalById(db, runId, prior));
      requireUnarchivedRun(db, runId);
      const step = requireStep(db, runId, stepId);
      if (step.on?.kind !== 'each') throw workflowInvalid('Only a repeated step can accept items.');
      const ref = step.on.signal;
      const producer = requireStep(db, runId, ref.stepId);
      const definition = getWorkflowStepSignal(producer, ref.signal);
      if (!definition || definition.delivery !== 'many') throw workflowInvalid('This group has no keyed signal schema.');
      const now = this.#now();
      const graph = new WorkflowGraph(db, runId, now);
      const receipt = graph.addItem(stepId, { ref, ...validateSignal(definition, key, payload), source: { kind: 'manual', actor, operationId } });
      if (receipt.inserted) graph.reconcile();
      saveOperation(db, runId, operationId, hash, receipt.row.id,
        receipt.inserted ? { kind: 'add-item', operationId, actor, createdAt: now, stepId, signalId: receipt.row.id } : undefined);
      return signalOccurrence(receipt.row);
    });
    this.#wake();
    return result;
  }

  addStep(raw: unknown, caller: WorkflowActor, snapshot?: WorkflowSettingsResolver): WorkflowRunAmendment {
    const request = normalizeAddStep(raw);
    const actor = normalizeActor(caller);
    const hash = requestHash('add-step', request, actor);
    const { runId, operationId, source, evidenceSignalId } = request;
    const prepared = this.#store.read(db => {
      if (priorOperation(db, runId, operationId, hash)) {
        const prior = db.query<{ amendment_json: string }, [string, string]>(
          'SELECT amendment_json FROM workflow_operations WHERE run_id = ? AND id = ?',
        ).get(runId, operationId)!;
        return { prior: JSON.parse(prior.amendment_json) as WorkflowRunAmendment };
      }
      const run = requireUnarchivedRun(db, runId);
      if (run.status === 'succeeded') throw workflowConflict('This run has finished. Start a follow-up run instead.');
      const stored = runSteps(db, runId).map(row => JSON.parse(row.step_json) as WorkflowStep);
      const base = { ...pinnedRevision(db, run).definition, steps: stored };
      const evidence = evidenceSignalId === undefined ? undefined : signalById(db, runId, evidenceSignalId);
      const parsed = parseWorkflowStepAddition(base, source, evidence ? { evidence: { stepId: evidence.step_id, signal: evidence.signal } } : {});
      if (!parsed.step) throw workflowInvalid(parsed.diagnostics[0]?.message ?? 'Invalid workflow step.');
      const previous = JSON.parse(run.context_json) as WorkflowExecutionContext;
      return { step: parsed.step, context: mergeExecutionContext(previous, request.executionContext), evidence };
    });
    if (prepared.prior) return prepared.prior;
    const captured = this.#captureStep(prepared.step, prepared.context, snapshot);
    const now = this.#now();
    const result = this.#withReferences([captured], () => this.#store.write(db => {
      requireUnarchivedRun(db, runId);
      const graph = new WorkflowGraph(db, runId, now);
      graph.insertStep(captured, true, prepared.evidence);
      graph.reconcile();
      const amendment: WorkflowRunAmendment = { kind: 'add-step', operationId, actor, createdAt: now, stepId: captured.step.id,
        ...(evidenceSignalId !== undefined && { evidenceSignalId }) };
      saveOperation(db, runId, operationId, hash, captured.step.id, amendment);
      return amendment;
    }));
    this.#wake();
    return result;
  }

  retry(raw: unknown, caller: WorkflowActor): { instanceId: string } {
    const request = normalizeRetry(raw);
    const actor = normalizeActor(caller);
    const hash = requestHash('retry', request, actor);
    const { runId, instanceId, operationId } = request;
    this.#store.write(db => {
      if (priorOperation(db, runId, operationId, hash)) return;
      requireUnarchivedRun(db, runId);
      const instance = requireInstance(db, runId, instanceId);
      if (requireStep(db, runId, instance.step_id).kind === 'decision') {
        throw workflowConflict('A decision step cannot be retried.');
      }
      if (instance.status !== 'failed') throw workflowConflict('Only a definitively failed attempt can be retried.');
      if (instance.attempt_count >= WORKFLOW_LIMITS.attemptsPerInstance) throw workflowLimit('This instance has reached its attempt limit.');
      db.query("UPDATE workflow_instances SET status = 'ready', reason = NULL WHERE id = ?").run(instanceId);
      new WorkflowGraph(db, runId, this.#now()).reconcile();
      saveOperation(db, runId, operationId, hash, instanceId);
    });
    this.#wake();
    return { instanceId };
  }

  stopRun(raw: unknown, caller: WorkflowActor): void {
    const request = normalizeStop(raw);
    const actor = normalizeActor(caller);
    const { runId, instanceId, operationId } = request;
    const hash = requestHash('stop', request, actor);
    const result = this.#store.write(db => {
      if (priorOperation(db, runId, operationId, hash)) return { attemptIds: [] as string[], changed: false };
      const run = requireUnarchivedRun(db, runId);
      const now = this.#now();
      const attemptIds: string[] = [];
      let changed = false;
      const requestedReason = `Stop requested by ${actor.name}.`;
      const stoppedBeforeReason = `Stopped before execution by ${actor.name}.`;
      const stoppedReason = `Stopped by ${actor.name}.`;
      if (instanceId !== undefined) {
        const instance = requireInstance(db, runId, instanceId);
        if (instance.status === 'running') {
          const live = db.query<{ id: string }, [string]>("SELECT id FROM workflow_attempts WHERE instance_id = ? AND status = 'running' LIMIT 1").get(instanceId);
          if (live) {
            attemptIds.push(live.id);
            db.query('UPDATE workflow_instances SET reason = ? WHERE id = ?').run(requestedReason, instanceId);
            changed = true;
          }
        } else if (instance.status === 'ready' || instance.status === 'waiting-executor') {
          db.query("UPDATE workflow_instances SET status = 'failed', reason = ? WHERE id = ?").run(stoppedBeforeReason, instanceId);
          changed = true;
        }
      } else if (run.status !== 'succeeded') {
        const live = db.query<{ id: string; instance_id: string }, [string]>(`
          SELECT a.id, i.id AS instance_id FROM workflow_attempts a
          JOIN workflow_instances i ON i.id = a.instance_id
          WHERE i.run_id = ? AND i.status = 'running' AND a.status = 'running'
        `).all(runId);
        for (const row of live) {
          attemptIds.push(row.id);
          db.query('UPDATE workflow_instances SET reason = ? WHERE id = ?').run(requestedReason, row.instance_id);
          changed = true;
        }
        const pending = db.query("UPDATE workflow_instances SET status = 'failed', reason = ? WHERE run_id = ? AND status IN ('ready', 'waiting-executor')")
          .run(stoppedBeforeReason, runId).changes;
        const decisions = db.query("UPDATE workflow_instances SET status = 'blocked', reason = ? WHERE run_id = ? AND status = 'awaiting-decision'")
          .run(stoppedReason, runId).changes;
        const blockedIntake = db.query("UPDATE workflow_run_steps SET intake = 'blocked', reason = ? WHERE run_id = ? AND intake = 'open'")
          .run(stoppedReason, runId).changes;
        if (pending > 0 || decisions > 0 || blockedIntake > 0) changed = true;
      }
      if (changed) new WorkflowGraph(db, runId, now).reconcile();
      // Stopping remains available even when the run has reached its normal operation limit.
      db.query('INSERT INTO workflow_operations (run_id, id, request_hash, result_id) VALUES (?, ?, ?, ?)')
        .run(runId, operationId, hash, instanceId ?? runId);
      return { attemptIds, changed };
    });
    for (const attemptId of result.attemptIds) this.#running.get(attemptId)?.stop.abort();
    if (result.changed) this.#wake();
  }

  handleChatRemoved(chatId: string): void {
    if (this.#closed) return;
    const removed = this.#store.write(db => {
      const attempt = db.query<{ id: string; run_id: string }, [string]>(`
        SELECT a.id, i.run_id FROM workflow_attempts a JOIN workflow_instances i ON i.id = a.instance_id
        WHERE a.chat_id = ? AND a.chat_confirmed = 1 AND a.chat_removed = 0
      `).get(chatId);
      if (!attempt) return null;
      db.query('UPDATE workflow_attempts SET chat_removed = 1 WHERE id = ?').run(attempt.id);
      const live = currentAttempt(db, attempt.id);
      if (live) {
        // Holds the execution slot until the runner settles; removing a chat is not confirmation of termination.
        db.query('UPDATE workflow_instances SET reason = ? WHERE id = ?')
          .run('Attempt chat removed; waiting for the exact turn to settle.', live.instance_id);
      }
      db.query('UPDATE workflow_runs SET updated_at = ? WHERE id = ?').run(this.#now(), attempt.run_id);
      return attempt;
    });
    if (!removed) return;
    this.#running.get(removed.id)?.shutdown.abort();
    this.#wake();
  }

  #captureStep(step: WorkflowStep, context: WorkflowExecutionContext, snapshot?: WorkflowSettingsResolver): CapturedStep {
    if (step.kind === 'decision') return { step, location: null, settings: null };
    const location = captureLocation(step, context);
    return { step, location, settings: captureSettings(step, location, snapshot ?? this.options.snapshotAgentSettings) };
  }

  async #recover(): Promise<void> {
    while (!this.#stopped) {
      const count = this.#store.write(db => {
        const rows = db.query<{ id: string }, [number]>("SELECT id FROM workflow_attempts WHERE status = 'running' LIMIT ?").all(RECOVERY_BATCH);
        const runs = new Set<string>();
        const now = this.#now();
        for (const { id } of rows) {
          const live = currentAttempt(db, id);
          if (!live) throw new Error('Workflow attempt does not match its instance.');
          const reason = !live.chat_confirmed && live.chat_id
            ? 'The controller restarted before chat publication was confirmed. Check the chat list before taking further action.'
            : 'The controller restarted before the exact turn settled.';
          const outcome = unfinishedAttempt(live, reason);
          finishAttempt(db, live, outcome.kind, outcome.reason, now);
          runs.add(live.run_id);
        }
        for (const runId of runs) new WorkflowGraph(db, runId, now).reconcile();
        return rows.length;
      });
      if (count < RECOVERY_BATCH) break;
      await yieldToLoop();
    }
  }

  #wake(): void {
    if (!this.#ready || this.#closed || this.#scheduled || this.#running.size >= this.#maxConcurrent) return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = null;
      try {
        const attempt = this.#claim();
        if (!attempt) return;
        this.#dispatch(attempt);
        this.#wake();
      } catch (error) {
        this.#ready = false;
        logger.warn('Workflow scheduling stopped.', { errorCode: diagnosticErrorCode(error) });
      }
    });
  }

  #claim(): WorkflowAttemptRequest | null {
    return this.#store.write(db => {
      const row = db.query<InstanceRow & { step_json: string; location_json: string; settings_json: string }, [string]>(`
        SELECT i.*, s.step_json, s.location_json, s.settings_json
        FROM workflow_instances i JOIN workflow_run_steps s ON s.run_id = i.run_id AND s.id = i.step_id
        WHERE i.status IN ('ready', 'waiting-executor') AND i.retired = 0
          AND (i.status = 'ready' OR s.executor_id IN (SELECT value FROM json_each(?)))
          AND (SELECT count(*) FROM workflow_instances live WHERE live.run_id = i.run_id AND live.step_id = i.step_id
            AND live.status = 'running') < s.max_concurrency
        ORDER BY i.rowid LIMIT 1
      `).get(JSON.stringify([...this.#readyExecutors.keys()]));
      if (!row) return null;
      const step = JSON.parse(row.step_json) as WorkflowStep;
      const location = JSON.parse(row.location_json) as WorkflowLocation;
      const settings = JSON.parse(row.settings_json) as NonNullable<CapturedStep['settings']>;
      const now = this.#now();
      const attemptId = randomUUID();
      const attemptNumber = row.attempt_count + 1;
      db.query("UPDATE workflow_instances SET status = 'running', reason = NULL, attempt_count = ? WHERE id = ?").run(attemptNumber, row.id);
      db.query("INSERT INTO workflow_attempts (id, instance_id, number, status, started_at) VALUES (?, ?, ?, 'running', ?)")
        .run(attemptId, row.id, attemptNumber, now);
      db.query("UPDATE workflow_runs SET status = 'running', updated_at = ? WHERE id = ?").run(now, row.run_id);
      const identity = { runId: row.run_id, stepId: row.step_id, instanceId: row.id, attemptId, attemptNumber, location };
      if (step.kind === 'command' && settings.kind === 'command') {
        const command = row.bindings_json === null
          ? step.command
          : wrapCommandWithBindings(step.command, settings.shell, JSON.parse(row.bindings_json) as JsonObject);
        return { ...identity, kind: 'command', command, shell: settings.shell };
      }
      if (step.kind === 'agent' && settings.kind === 'agent' && row.prompt !== null) {
        const { kind: _kind, ...agent } = settings;
        return { ...identity, kind: 'agent', prompt: row.prompt, settings: agent, signals: step.signals ?? {} };
      }
      throw new Error('Workflow ready instance has no executable step.');
    });
  }

  #dispatch(attempt: WorkflowAttemptRequest): void {
    const shutdown = new AbortController();
    const stop = new AbortController();
    const { attemptId, runId, instanceId, location: { executorId } } = attempt;
    const readiness = this.#readyExecutors.get(executorId);
    this.#running.set(attemptId, { runId, instanceId, shutdown, stop });
    void Promise.resolve().then(async () => {
      if (this.#stopped) return;
      let result: WorkflowAttemptResult | null;
      if (stop.signal.aborted) {
        result = { kind: 'failed', reason: 'Stopped before execution started.' };
      } else {
        try {
          result = await this.options.runner.run(attempt, {
            signal: shutdown.signal,
            stopSignal: stop.signal,
            attachChat: (chatId, turnId) => this.#attachChat(attemptId, chatId, turnId),
            confirmChat: () => this.#confirmChat(attemptId),
            emit: request => this.#emit(attemptId, request),
          });
        } catch {
          result = null;
        }
      }
      if (this.#closed) return;
      if (result?.kind === 'unavailable' && readiness === this.#readyExecutors.get(executorId)) this.#readyExecutors.delete(executorId);
      this.#settle(attemptId, result);
    }).catch(error => {
      this.#ready = false;
      logger.warn('Workflow attempt settlement failed; restart is required for recovery.', { errorCode: diagnosticErrorCode(error) });
    }).finally(() => {
      this.#running.delete(attemptId);
      this.#wake();
    });
  }

  #attachChat(attemptId: string, rawChatId: string, rawTurnId: string): void {
    const chatId = workflowIdentifier(rawChatId, 'Chat id');
    const turnId = workflowIdentifier(rawTurnId, 'Turn id');
    if (this.#stopped) throw workflowConflict('Workflow admissions have stopped.');
    this.#store.write(db => {
      const row = currentAttempt(db, attemptId);
      if (!row || row.chat_removed) throw workflowConflict('This attempt is no longer live.');
      if (row.chat_id === chatId && row.turn_id === turnId) return;
      if (row.chat_id !== null || db.query('SELECT 1 FROM workflow_attempts WHERE chat_id = ?').get(chatId)) {
        throw workflowConflict('Every attempt requires a fresh chat and exactly one turn.');
      }
      db.query('UPDATE workflow_attempts SET chat_id = ?, turn_id = ? WHERE id = ?').run(chatId, turnId, attemptId);
    });
  }

  #confirmChat(attemptId: string): void {
    const confirmed = this.#store.write(db => {
      const row = currentAttempt(db, attemptId);
      if (!row?.chat_id || !row.turn_id || row.chat_removed) throw workflowConflict('This attempt has no live chat reservation.');
      if (row.chat_confirmed) return false;
      db.query('UPDATE workflow_attempts SET chat_confirmed = 1 WHERE id = ?').run(attemptId);
      db.query('UPDATE workflow_runs SET updated_at = ? WHERE id = ?').run(this.#now(), row.run_id);
      return true;
    });
    if (confirmed) this.#wake();
  }

  #emit(attemptId: string, request: WorkflowEmitRequest): WorkflowSignalOccurrence {
    const signal = workflowIdentifier(request.signal, 'Signal name');
    if (this.#stopped) throw workflowConflict('Workflow admissions have stopped.');
    if (signal === WORKFLOW_TURN_COMPLETED) throw workflowInvalid('Only Garcon can emit turn_completed.');
    const result = this.#store.write(db => {
      const live = currentAttempt(db, attemptId);
      if (!live?.chat_id || !live.turn_id || live.chat_removed) throw workflowConflict('This attempt has no live turn.');
      const step = requireStep(db, live.run_id, live.step_id);
      if (step.kind !== 'agent' || !step.signals || !Object.hasOwn(step.signals, signal)) {
        throw workflowInvalid('This agent step does not declare that signal.');
      }
      const validated = validateSignal(step.signals[signal]!, request.key, request.payload);
      const graph = new WorkflowGraph(db, live.run_id, this.#now());
      const receipt = graph.emit({
        ref: { stepId: step.id, signal }, instanceId: live.instance_id, scope: live.instance_id, ...validated,
        source: { kind: 'attempt', attemptId, chatId: live.chat_id, turnId: live.turn_id },
      });
      if (receipt.inserted) graph.reconcile();
      return { signal: signalOccurrence(receipt.row), inserted: receipt.inserted };
    });
    if (result.inserted) this.#wake();
    return result.signal;
  }

  #settle(attemptId: string, outcome: WorkflowAttemptResult | null): void {
    const settled = this.#store.write(db => {
      const live = currentAttempt(db, attemptId);
      if (!live) return false;
      const result = outcome ?? unfinishedAttempt(live, UNKNOWN_OUTCOME);
      const now = this.#now();
      const graph = new WorkflowGraph(db, live.run_id, now);
      if (live.chat_removed) {
        finishAttempt(db, live, 'unknown', REMOVED_CHAT_OUTCOME, now);
      } else if (result.kind === 'succeeded' && live.chat_confirmed && live.chat_id && live.turn_id) {
        let output: string | null = null;
        let reason = result.output?.kind === 'incomplete' ? 'Final output was not captured completely.' : null;
        if (result.output?.kind === 'complete') {
          try {
            if (typeof result.output.text !== 'string') throw workflowInvalid('Final output was not text.');
            output = workflowJson(result.output.text, 'Final output');
          }
          catch (error) {
            if (!(error instanceof DomainError)) throw error;
            reason = error.message;
          }
        }
        finishAttempt(db, live, 'succeeded', reason, now);
        graph.emit({
          ref: { stepId: live.step_id, signal: WORKFLOW_TURN_COMPLETED }, instanceId: live.instance_id, scope: live.instance_id,
          key: '', payloadJson: output, source: { kind: 'completion', attemptId, chatId: live.chat_id, turnId: live.turn_id },
        });
      } else {
        const kind = result.kind === 'succeeded' ? 'unknown' : result.kind;
        let reason = result.kind === 'succeeded' ? UNKNOWN_OUTCOME : result.reason.slice(0, 512);
        if (kind === 'unknown' && live.chat_id && !live.chat_confirmed) {
          reason = 'Chat publication could not be confirmed. Check the chat list before taking further action. ' + reason;
        }
        const diagnostic = result.kind === 'succeeded' || !result.diagnostic ? null : result.diagnostic.slice(0, 1024);
        finishAttempt(db, live, kind, reason, now, diagnostic);
      }
      graph.reconcile();
      return true;
    });
    if (settled) this.#wake();
  }

  #now(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }
}
