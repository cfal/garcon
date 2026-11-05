import type { Database } from 'bun:sqlite';
import { WORKFLOW_LIMITS, type WorkflowMutation } from '../../../common/workflows.js';
import { GIT_OPERATION_TIMEOUT_MS } from '../../../common/git-execution.js';
import { matchesManagedTarget } from './managed-target.js';
import { workflowConflict } from './errors.js';
import { appendWorkflowActivity, requireAttempt, requireWorkflow, readPlan, workflowRevision } from './records.js';
import { assertResourceBudget } from './resources.js';
import { requireOperation } from './resource-dispatch.js';
import type { WorkflowStore } from './store.js';
import { definitelyNotDispatched, inspectRecoveredWorkflowRepository, type WorkflowRuntimeResolver } from './adapters/repository-runtime.js';
import { workflowDigest } from './inputs.js';

type CleanupRequest = Extract<WorkflowMutation, { action: 'cleanup' }>;

function requireCleanup(db: Database, request: CleanupRequest, operationId: string) {
  const workflow = requireWorkflow(db, request.workflowId);
  const attempt = requireAttempt(db, request.attemptId);
  const resource = attempt.managedTarget;
  const task = readPlan(db, attempt.workflowId, attempt.planRevision).plan.tasks.find(task => task.id === attempt.taskId)!;
  if (attempt.workflowId !== workflow.id || !resource || resource.resourceKey !== request.resourceKey
    || !workflow.archived && workflow.desired !== 'canceled'
    || !db.query('SELECT 1 FROM resource_claims WHERE resource_key=? AND attempt_id=? AND retained=1 AND quarantined=0 AND risk_released=0')
      .get(request.resourceKey, request.attemptId)
    || db.query(`SELECT 1 FROM attempts WHERE workflow_id=? AND
      (resolution IN ('open','unknown') OR control_state='leased' OR dispatch_phase!='settled')`).get(workflow.id)
    || attempt.result?.termination !== 'observed' && attempt.resolution !== 'not-started'
      && !(task.spec.kind === 'publish-pr' && attempt.resolution === 'succeeded')
    || db.query(`SELECT 1 FROM operation_intents WHERE attempt_id=? AND id!=? AND
      (status IN ('planned','dispatching','unknown','abandoned') OR kind='cleanup' AND status='succeeded')`).get(attempt.attemptId, operationId)) {
    return workflowConflict('Cleanup requires an archived or canceled workflow, settled writers and an unquarantined retained managed worktree.');
  }
  return { attempt, resource };
}

export function planWorkflowCleanup(db: Database, request: CleanupRequest, id: string): string {
  const captured = requireCleanup(db, request, id);
  const count = db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM operation_intents WHERE attempt_id=? AND kind='cleanup' AND status!='not-started'").get(request.attemptId)!.count;
  if (count >= 3) workflowConflict('Cleanup admission limit reached. Inspect the retained resource manually.');
  const operations = db.query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM operation_intents WHERE attempt_id=?').get(request.attemptId)!.count;
  if (operations >= WORKFLOW_LIMITS.resourceOperations) workflowConflict('Resource operation limit reached.');
  const payload = JSON.stringify({ version: 1, request, resource: captured.resource });
  assertResourceBudget(db, request.workflowId, Buffer.byteLength(payload) + WORKFLOW_LIMITS.evidenceBytes);
  db.query("INSERT INTO operation_intents VALUES (?,?,'cleanup',?,'planned',?,NULL,0,NULL)")
    .run(id, request.attemptId, request.resourceKey, payload);
  return request.workflowId;
}

export async function cleanupWorkflowResource(store: WorkflowStore, id: string, resolve: WorkflowRuntimeResolver, shutdown: AbortSignal,
  options: { now(): string; onInvalidated(id: string, revision: number): void; inspectWriters(executorId: string, path: string, signal: AbortSignal): Promise<void> }) {
  let status: 'succeeded' | 'not-started' | 'unknown' = 'not-started';
  let detail = 'Cleanup was not started; the resource remains retained.';
  let dispatched = false;
  try {
    const operation = store.read(db => requireOperation(db, id));
    if (operation.kind !== 'cleanup' || operation.status !== 'planned') return;
    const payload = JSON.parse(operation.payload) as { version: number; request: CleanupRequest; resource: NonNullable<ReturnType<typeof requireAttempt>['managedTarget']> };
    const captured = store.read(db => requireCleanup(db, payload.request, id));
    if (payload.version !== 1 || workflowDigest(captured.resource) !== workflowDigest(payload.resource)) workflowConflict('Cleanup resource changed.');
    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(5 * GIT_OPERATION_TIMEOUT_MS)]);
    await options.inspectWriters(captured.resource.target.executorId, captured.resource.target.projectPath, signal);
    const observed = await inspectRecoveredWorkflowRepository(resolve, captured.resource, signal);
    if (observed.instanceId !== captured.resource.instanceId) {
      workflowConflict('Cleanup cannot establish prior native writer termination after an executor restart. The worktree remains retained.');
    }
    if (!matchesManagedTarget(captured.resource, observed.managed) || observed.managed.dirty || observed.managed.head !== payload.request.expectedHead) {
      workflowConflict('Cleanup head, identity or cleanliness changed.');
    }
    const git = await (await resolve(captured.resource.target.executorId)).getGitService({ signal });
    await options.inspectWriters(captured.resource.target.executorId, captured.resource.target.projectPath, signal);
    store.transaction(db => {
      if (signal.aborted) workflowConflict('Cleanup was canceled before dispatch.');
      const current = requireCleanup(db, payload.request, id);
      if (workflowDigest(current) !== workflowDigest(captured) || requireOperation(db, id).status !== 'planned') workflowConflict('Cleanup ownership changed.');
      db.query("UPDATE operation_intents SET status='dispatching' WHERE id=?").run(id);
    });
    dispatched = true;
    const result = await git.removeManagedWorktree({ projectPath: captured.resource.sourceProjectPath,
      worktreePath: captured.resource.target.projectPath, managedResourceId: captured.resource.managedResourceId, operationId: captured.resource.operationId,
      expectedRepositoryIdentity: captured.resource.repositoryIdentity, expectedWorktreeIdentity: captured.resource.worktreeIdentity,
      expectedHead: payload.request.expectedHead, expectedBranch: captured.resource.branch },
    { signal: shutdown, instanceId: observed.instanceId, timeoutMs: GIT_OPERATION_TIMEOUT_MS });
    if (result.executorId !== observed.executorId || result.instanceId !== observed.instanceId || !result.success
      || workflowDigest(result.removed) !== workflowDigest(observed.managed)) throw new Error('Cleanup reply identity changed.');
    status = 'succeeded'; detail = 'Managed worktree removed. Branch, marker and evidence retained.';
  } catch (error) {
    status = dispatched && !definitelyNotDispatched(error) ? 'unknown' : 'not-started';
    detail = status === 'unknown' ? 'Managed removal may have executed. Its exact resource is quarantined; cleanup will not repeat.'
      : error instanceof Error ? `Cleanup not started: ${error.message}`.slice(0, 2048)
        : 'Cleanup rejected before removal. Check active or uncertain native work, runtime restarts, identity, expected head and cleanliness.';
  } finally {
    const settled = store.transaction(db => {
      const operation = requireOperation(db, id);
      if (operation.kind !== 'cleanup' || !['planned', 'dispatching'].includes(operation.status)) return null;
      const attempt = requireAttempt(db, operation.attemptId);
      db.query('UPDATE operation_intents SET status=?,result_json=? WHERE id=?').run(status, JSON.stringify({ detail }), id);
      if (status === 'succeeded') db.query('DELETE FROM resource_claims WHERE resource_key=? AND attempt_id=?').run(operation.resourceKey, attempt.attemptId);
      if (status === 'unknown') db.query('UPDATE resource_claims SET quarantined=1 WHERE resource_key=? AND attempt_id=?').run(operation.resourceKey, attempt.attemptId);
      appendWorkflowActivity(db, attempt.workflowId, 'cleanup-observed', 'engine', detail, options.now());
      return { id: attempt.workflowId, revision: workflowRevision(db) };
    });
    if (settled) options.onInvalidated(settled.id, settled.revision);
  }
}
