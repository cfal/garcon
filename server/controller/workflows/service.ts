import type { Database } from 'bun:sqlite';
import { parseWorkflowMutationRequest, workflowId, workflowInteger } from '../../../common/workflow-validation.js';
import { WORKFLOW_LIMITS, type WorkflowArtifact, type WorkflowMutation, type WorkflowMutationResult, type WorkflowOperationResult } from '../../../common/workflows.js';
import { DomainError } from '../../common/domain-error.js';
import type { WorkflowAuthority, WorkflowServiceOptions } from './contracts.js';
import { validateWorkflowInput, workflowConflict } from './errors.js';
import { workflowMermaid } from './graph.js';
import { workflowDigest } from './inputs.js';
import { mutateWorkflow } from './mutations.js';
import { appendWorkflowActivity, listWorkflowRecords, readAttemptHistory, readPlan, readWorkflowActivity, readWorkflowDetail, requireWorkflow, workflowRevision } from './records.js';
import { WorkflowStore } from './store.js';
import type { WorkflowBootstrap, WorkflowHttpMutationRequest } from '../../../common/workflow-http.js';
import { captureWorkflowAdoption, commitWorkflowAdoption } from './adoption.js';
import { GIT_OPERATION_TIMEOUT_MS } from '../../../common/git-execution.js';
import { planPublicationRecheck } from './publication-recovery.js';
import { planWorkflowCleanup } from './cleanup.js';
import { inspectWorkflowAttempt, inspectWorkflowGate, readWorkflowOverview } from './inspection.js';

const CLI_ACTIONS: ReadonlySet<WorkflowMutation['action']> = new Set(['create', 'plan', 'pause', 'stop']);

export class WorkflowService {
  constructor(readonly store: WorkflowStore, private readonly options: WorkflowServiceOptions) {}

  bootstrap(): WorkflowBootstrap {
    return this.store.read(database => ({
      storeId: database.query<{ store_id: string }, []>('SELECT store_id FROM workflow_metadata WHERE singleton=1').get()!.store_id,
      revision: workflowRevision(database), enabled: this.options.enabled(),
    }));
  }

  async executeHttp(request: WorkflowHttpMutationRequest, authority: WorkflowAuthority, signal = new AbortController().signal): Promise<WorkflowMutationResult> {
    authority.assertCurrent();
    if (request.expectedStoreId !== this.bootstrap().storeId) workflowConflict('Workflow storage identity changed.');
    const parsed = validateWorkflowInput(() => parseWorkflowMutationRequest({ operationId: request.operationId, mutation: request.mutation }));
    if (parsed.mutation.action === 'cleanup') {
      const mutation = parsed.mutation;
      this.#authorize(mutation.action, authority);
      const saved = this.store.read(db => readOperation(db, parsed.operationId, authority, workflowDigest(mutation)));
      if (saved.kind === 'completed') return saved.result;
      if (saved.kind === 'result-expired') throw new DomainError('WORKFLOW_RESULT_EXPIRED', 'The completed operation result expired. It will not run again.', 409);
      if (!this.options.cleanup) throw new DomainError('WORKFLOW_UNAVAILABLE', 'Managed cleanup is unavailable.', 503);
      signal.throwIfAborted();
      const result = this.#execute(parsed, authority, db => planWorkflowCleanup(db, mutation, parsed.operationId));
      await this.options.cleanup(parsed.operationId);
      return result;
    }
    if (parsed.mutation.action === 'recheck-publication') {
      const mutation = parsed.mutation;
      this.#authorize(mutation.action, authority);
      const saved = this.store.read(db => readOperation(db, parsed.operationId, authority, workflowDigest(mutation)));
      if (saved.kind === 'completed') return saved.result;
      if (saved.kind === 'result-expired') throw new DomainError('WORKFLOW_RESULT_EXPIRED', 'The completed operation result expired. It will not run again.', 409);
      if (!this.options.recheckPublication) throw new DomainError('WORKFLOW_UNAVAILABLE', 'Publication recovery is unavailable.', 503);
      const result = this.#execute(parsed, authority, db => planPublicationRecheck(db, mutation, parsed.operationId));
      await this.options.recheckPublication(parsed.operationId, signal);
      return result;
    }
    if (parsed.mutation.action === 'resolve' && parsed.mutation.resolution === 'adopt') {
      const mutation = parsed.mutation;
      this.#authorize(mutation.action, authority);
      const saved = this.store.read(db => readOperation(db, parsed.operationId, authority, workflowDigest(mutation)));
      if (saved.kind === 'completed') return saved.result;
      if (saved.kind === 'result-expired') throw new DomainError('WORKFLOW_RESULT_EXPIRED', 'The completed operation result expired. It will not run again.', 409);
      if (!this.options.observeAdoption) throw new DomainError('WORKFLOW_UNAVAILABLE', 'Artifact recovery is unavailable.', 503);
      const captured = this.store.read(db => captureWorkflowAdoption(db, mutation));
      const readSignal = AbortSignal.any([signal, AbortSignal.timeout(3 * GIT_OPERATION_TIMEOUT_MS)]);
      const observed = await this.options.observeAdoption(captured, readSignal);
      readSignal.throwIfAborted();
      if (request.expectedStoreId !== this.bootstrap().storeId) workflowConflict('Workflow storage identity changed.');
      return this.#execute(parsed, authority, (db, now) => commitWorkflowAdoption(db, mutation, parsed.operationId, authority.key, captured, observed, now));
    }
    return this.execute({ operationId: request.operationId, mutation: request.mutation }, authority);
  }

  execute(value: unknown, authority: WorkflowAuthority): WorkflowMutationResult {
    return this.#execute(value, authority);
  }

  #execute(value: unknown, authority: WorkflowAuthority, apply?: (db: Database, now: string) => string): WorkflowMutationResult {
    const request = validateWorkflowInput(() => parseWorkflowMutationRequest(value));
    this.#authorize(request.mutation.action, authority);
    const fingerprint = workflowDigest(request.mutation);
    const committed = this.store.transaction(database => {
      this.#authorize(request.mutation.action, authority);
      const previous = readOperation(database, request.operationId, authority, fingerprint);
      if (previous.kind === 'result-expired') throw new DomainError('WORKFLOW_RESULT_EXPIRED', 'This operation completed, but its result expired. It will not run again.', 409);
      if (previous.kind === 'completed') return { result: previous.result, changed: false };
      const now = this.options.now?.() ?? new Date().toISOString();
      const id = validateWorkflowInput(() => apply ? apply(database, now) : mutateWorkflow(database, request.mutation, authority.key, now));
      appendWorkflowActivity(database, id, request.mutation.action, authority.key,
        request.mutation.action === 'resolve' || request.mutation.action === 'clear-hold' ? request.mutation.evidence : request.operationId, now);
      const workflow = requireWorkflow(database, id);
      const result: WorkflowMutationResult = { operationId: request.operationId, workflowId: id,
        revision: workflow.revision, collectionRevision: workflowRevision(database) };
      database.query('INSERT INTO mutation_results VALUES (?,?,?,?,?)').run(request.operationId, authority.key, fingerprint, JSON.stringify(result), now);
      return { result, changed: true };
    });
    if (committed.changed) {
      const action = request.mutation.action;
      try {
        if (action === 'pause' || action === 'stop' || action === 'cancel' || action === 'activate') this.options.onControl?.(committed.result.workflowId, action);
      } catch (error) {
        this.store.close();
        console.error('Workflow control delivery failed; storage fenced', error);
      }
      try { this.options.onInvalidated?.(committed.result.workflowId, committed.result.collectionRevision); }
      catch (error) { console.error('Workflow invalidation delivery failed', error); }
    }
    return committed.result;
  }

  operation(id: string, authority: WorkflowAuthority): WorkflowOperationResult {
    authority.assertCurrent();
    validateWorkflowInput(() => workflowId(id));
    return this.store.read(database => readOperation(database, id, authority));
  }
  detail(id: string) {
    validateWorkflowInput(() => workflowId(id));
    return this.store.read(database => readWorkflowDetail(database, id));
  }
  overview(id: string) {
    validateWorkflowInput(() => workflowId(id));
    return this.store.read(db => readWorkflowOverview(db, id));
  }
  plan(id: string, revision: number) {
    validateWorkflowInput(() => { workflowId(id); workflowInteger(revision, 1); });
    return this.store.read(db => requestedPlan(db, id, revision));
  }
  inspectGate(id: string, gateId: string) {
    validateWorkflowInput(() => { workflowId(id); workflowId(gateId); });
    return this.store.read(db => inspectWorkflowGate(db, id, gateId));
  }
  list(after: string | null = null, limit = 50) {
    validateWorkflowInput(() => { if (after) workflowId(after); workflowInteger(limit, 1, WORKFLOW_LIMITS.pageSize); });
    return this.store.read(database => ({ revision: workflowRevision(database), workflows: listWorkflowRecords(database, after, limit) }));
  }
  diagram(id: string, revision: number): string {
    validateWorkflowInput(() => { workflowId(id); workflowInteger(revision, 1); });
    return this.store.read(database => workflowMermaid(requestedPlan(database, id, revision).plan));
  }
  attempts(id: string, before: string | null = null, limit = 50) {
    validateWorkflowInput(() => { workflowId(id); if (before) workflowId(before); workflowInteger(limit, 1, WORKFLOW_LIMITS.pageSize); });
    return this.store.read(database => {
      requireWorkflow(database, id);
      return readAttemptHistory(database, id, before, limit);
    });
  }
  inspectAttempt(id: string, attemptId: string) {
    validateWorkflowInput(() => { workflowId(id); workflowId(attemptId); });
    return this.store.read(db => inspectWorkflowAttempt(db, id, attemptId));
  }
  activity(id: string, before = Number.MAX_SAFE_INTEGER, limit = 50) {
    validateWorkflowInput(() => { workflowId(id); workflowInteger(before, 1); workflowInteger(limit, 1, WORKFLOW_LIMITS.pageSize); });
    return this.store.read(database => readWorkflowActivity(database, id, before, limit));
  }
  artifacts(id: string, after: string | null = null, limit = 50): WorkflowArtifact[] {
    validateWorkflowInput(() => { workflowId(id); if (after) workflowId(after); workflowInteger(limit, 1, WORKFLOW_LIMITS.pageSize); });
    return this.store.read(database => {
      requireWorkflow(database, id);
      return database.query<{ payload_json: string }, [string, string | null, string | null, number, number]>(`WITH page AS (
        SELECT r.id,r.payload_json FROM artifacts r JOIN attempts a ON a.id=r.attempt_id
        WHERE a.workflow_id=? AND (? IS NULL OR r.id>?) ORDER BY r.id LIMIT ?)
        SELECT payload_json FROM (SELECT *,SUM(length(CAST(payload_json AS BLOB))+1) OVER (ORDER BY id) AS bytes FROM page)
        WHERE bytes<=? ORDER BY id`).all(id, after, after, limit, WORKFLOW_LIMITS.pageBytes - 1024).map(row => JSON.parse(row.payload_json));
    });
  }
  expireResult(id: string): void {
    this.store.transaction(database => database.query('UPDATE mutation_results SET result_json=NULL WHERE operation_id=?').run(id));
  }
  #authorize(action: WorkflowMutation['action'], authority: WorkflowAuthority): void {
    authority.assertCurrent();
    if (!CLI_ACTIONS.has(action) && !authority.browserSession) throw new DomainError('WORKFLOW_FORBIDDEN', 'This action requires a current authenticated browser session.', 403);
    if (!this.options.enabled() && !['pause', 'stop', 'cancel', 'archive', 'resolve', 'clear-hold', 'recheck-publication', 'cleanup'].includes(action))
      throw new DomainError('WORKFLOW_DISABLED', 'Workflows are disabled.', 503);
  }
}

function requestedPlan(database: Database, id: string, revision: number) {
  requireWorkflow(database, id);
  if (!database.query('SELECT 1 FROM plan_revisions WHERE workflow_id=? AND revision=?').get(id, revision)) {
    throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow plan revision not found.', 404);
  }
  return readPlan(database, id, revision);
}

function readOperation(database: Database, id: string, authority: WorkflowAuthority, fingerprint?: string): WorkflowOperationResult {
  const row = database.query<{ authority_key: string; fingerprint: string; result_json: string | null }, [string]>(
    'SELECT authority_key,fingerprint,result_json FROM mutation_results WHERE operation_id=?',
  ).get(id);
  if (!row) return { kind: 'not-found' };
  if (row.authority_key !== authority.key || fingerprint !== undefined && fingerprint !== row.fingerprint) workflowConflict('Operation identity was already used with different authority or content.');
  return row.result_json === null ? { kind: 'result-expired' } : { kind: 'completed', result: JSON.parse(row.result_json) };
}
