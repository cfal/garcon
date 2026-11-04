import type { Database } from 'bun:sqlite';
import { parseWorkflowMutationRequest, workflowId, workflowInteger } from '../../../common/workflow-validation.js';
import { WORKFLOW_LIMITS, type WorkflowMutation, type WorkflowMutationResult, type WorkflowOperationResult } from '../../../common/workflows.js';
import { DomainError } from '../../common/domain-error.js';
import type { WorkflowAuthority, WorkflowServiceOptions } from './contracts.js';
import { validateWorkflowInput, workflowConflict } from './errors.js';
import { workflowMermaid } from './graph.js';
import { workflowDigest } from './inputs.js';
import { mutateWorkflow } from './mutations.js';
import { appendWorkflowActivity, listWorkflowRecords, readAttemptHistory, readPlan, readWorkflowActivity, readWorkflowDetail, requireWorkflow, workflowRevision } from './records.js';
import { WorkflowStore } from './store.js';

const CLI_ACTIONS: ReadonlySet<WorkflowMutation['action']> = new Set(['create', 'plan', 'pause', 'stop']);

export class WorkflowService {
  constructor(readonly store: WorkflowStore, private readonly options: WorkflowServiceOptions) {}

  execute(value: unknown, authority: WorkflowAuthority): WorkflowMutationResult {
    const request = validateWorkflowInput(() => parseWorkflowMutationRequest(value));
    this.#authorize(request.mutation.action, authority);
    const fingerprint = workflowDigest(request.mutation);
    const committed = this.store.transaction(database => {
      this.#authorize(request.mutation.action, authority);
      const previous = readOperation(database, request.operationId, authority, fingerprint);
      if (previous.kind === 'result-expired') throw new DomainError('WORKFLOW_RESULT_EXPIRED', 'This operation completed, but its result expired. It will not run again.', 409);
      if (previous.kind === 'completed') return { result: previous.result, changed: false };
      const now = this.options.now?.() ?? new Date().toISOString();
      const id = validateWorkflowInput(() => mutateWorkflow(database, request.mutation, authority.key, now));
      appendWorkflowActivity(database, id, request.mutation.action, authority.key,
        request.mutation.action === 'resolve' ? request.mutation.evidence : request.operationId, now);
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
  list(after: string | null = null, limit = 50) {
    validateWorkflowInput(() => { if (after) workflowId(after); workflowInteger(limit, 1, WORKFLOW_LIMITS.pageSize); });
    return this.store.read(database => ({ revision: workflowRevision(database), workflows: listWorkflowRecords(database, after, limit) }));
  }
  diagram(id: string, revision: number): string {
    validateWorkflowInput(() => { workflowId(id); workflowInteger(revision, 1); });
    return this.store.read(database => { requireWorkflow(database, id); return workflowMermaid(readPlan(database, id, revision).plan); });
  }
  attempts(id: string, before: string | null = null, limit = 50) {
    validateWorkflowInput(() => { workflowId(id); if (before) workflowId(before); workflowInteger(limit, 1, WORKFLOW_LIMITS.pageSize); });
    return this.store.read(database => {
      requireWorkflow(database, id);
      return readAttemptHistory(database, id, before, limit);
    });
  }
  activity(id: string, before = Number.MAX_SAFE_INTEGER, limit = 50) {
    validateWorkflowInput(() => { workflowId(id); workflowInteger(before, 1); workflowInteger(limit, 1, WORKFLOW_LIMITS.pageSize); });
    return this.store.read(database => readWorkflowActivity(database, id, before, limit));
  }
  expireResult(id: string): void {
    this.store.transaction(database => database.query('UPDATE mutation_results SET result_json=NULL WHERE operation_id=?').run(id));
  }
  #authorize(action: WorkflowMutation['action'], authority: WorkflowAuthority): void {
    authority.assertCurrent();
    if (!CLI_ACTIONS.has(action) && !authority.browserSession) throw new DomainError('WORKFLOW_FORBIDDEN', 'This action requires a current authenticated browser session.', 403);
    if (!this.options.enabled() && action !== 'pause' && action !== 'stop') throw new DomainError('WORKFLOW_DISABLED', 'Workflows are disabled.', 503);
  }
}

function readOperation(database: Database, id: string, authority: WorkflowAuthority, fingerprint?: string): WorkflowOperationResult {
  const row = database.query<{ authority_key: string; fingerprint: string; result_json: string | null }, [string]>(
    'SELECT authority_key,fingerprint,result_json FROM mutation_results WHERE operation_id=?',
  ).get(id);
  if (!row) return { kind: 'not-found' };
  if (row.authority_key !== authority.key || fingerprint !== undefined && fingerprint !== row.fingerprint) workflowConflict('Operation identity was already used with different authority or content.');
  return row.result_json === null ? { kind: 'result-expired' } : { kind: 'completed', result: JSON.parse(row.result_json) };
}
