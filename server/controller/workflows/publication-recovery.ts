import type { Database } from 'bun:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { matchesPublication, sameGhRepository } from '../../../common/gh-identity.js';
import { WORKFLOW_LIMITS, type WorkflowMutation, type WorkflowAttempt, type WorkflowPlanTask } from '../../../common/workflows.js';
import type { WorkflowPublicationPort } from './publication-contracts.js';
import { workflowConflict } from './errors.js';
import { workflowDigest } from './inputs.js';
import { appendWorkflowActivity, requireAttempt, workflowRevision } from './records.js';
import { requireOperation } from './resource-dispatch.js';
import { assertResourceBudget } from './resources.js';
import type { WorkflowStore } from './store.js';
import { requirePublicationApproval, workflowPublicationMarker } from './publication-manifest.js';
import type { WorkflowAdoptionRequest } from './adoption.js';

export type WorkflowPublicationLookup = Awaited<ReturnType<WorkflowPublicationPort['find']>>;
export function savedPublication(db: Database, attemptId: string, operationId: string) {
  const attempt = requireAttempt(db, attemptId);
  const operation = requireOperation(db, operationId);
  if (operation.attemptId !== attemptId || operation.kind !== 'publication' || !['unknown', 'succeeded'].includes(operation.status)) {
    return workflowConflict('Publication has no possibly dispatched creation to inspect.');
  }
  const payload = JSON.parse(operation.payload) as { version: number; stage: string;
    approval: ReturnType<typeof requirePublicationApproval>; resource: WorkflowAttempt['managedTarget'] };
  const publication = payload.approval?.publication;
  if (payload.version !== 1 || payload.stage !== 'create' || !publication || publication.operationId !== operationId
    || !payload.resource?.target.remote || payload.resource.target.remote.url !== publication.remoteUrl
    || publication.executorId !== payload.resource.target.executorId || !publication.body.includes(workflowPublicationMarker(operationId))) {
    return workflowConflict('Saved publication identity is invalid.');
  }
  return { attempt, operation, publication, digest: payload.approval.digest, remote: payload.resource.target.remote.name };
}

export function capturePublicationAdoption(db: Database, request: WorkflowAdoptionRequest, attempt: WorkflowAttempt,
  task: WorkflowPlanTask, workflowRevision: number) {
  const approved = requirePublicationApproval(db, attempt);
  const saved = savedPublication(db, attempt.attemptId, approved.publication.operationId);
  if (request.commit !== null && request.commit !== saved.publication.headCommit) workflowConflict('Publication head changed.');
  if (db.query('SELECT 1 FROM artifacts WHERE attempt_id=?').get(attempt.attemptId)
    || db.query(`SELECT 1 FROM operation_intents WHERE attempt_id=? AND id!=?
      AND status IN ('planned','dispatching','unknown','abandoned')`).get(attempt.attemptId, saved.operation.id)
    || !db.query(`SELECT 1 FROM operation_intents WHERE attempt_id=? AND kind='publication'
      AND status='succeeded' AND json_extract(payload_json,'$.stage')='push'`).get(attempt.attemptId)) {
    workflowConflict('Publication recovery requires a definite push and no other uncertain effects.');
  }
  return { kind: 'publication' as const, attempt, task, workflowRevision, saved };
}

export function exactRecoveredPublication(found: WorkflowPublicationLookup, saved: ReturnType<typeof savedPublication>) {
  if (found.executorId !== saved.publication.executorId || !sameGhRepository(found.repository, saved.publication.repository)
    || found.actor.id !== saved.publication.actor.id || found.actor.login !== saved.publication.actor.login
    || found.pulls.length !== 1 || !matchesPublication(found.pulls[0]!, saved.publication)) {
    return workflowConflict('Exactly one open pull request must match the original repository, actor, body and commits.');
  }
  return found.pulls[0]!;
}

export function planPublicationRecheck(db: Database, request: Extract<WorkflowMutation, { action: 'recheck-publication' }>, id: string) {
  const saved = savedPublication(db, request.attemptId, request.publicationOperationId);
  if (saved.attempt.workflowId !== request.workflowId || saved.attempt.controlState === 'leased' || saved.attempt.dispatchPhase !== 'settled') {
    workflowConflict('Publication still has a live admission owner.');
  }
  if (db.query(`SELECT 1 FROM operation_intents WHERE attempt_id=? AND json_extract(payload_json,'$.stage')='recheck'
    AND status IN ('planned','dispatching')`).get(request.attemptId)) workflowConflict('Publication recheck is already running.');
  const count = db.query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM operation_intents WHERE attempt_id=?').get(request.attemptId)!.count;
  if (count >= WORKFLOW_LIMITS.resourceOperations) workflowConflict('Resource operation limit reached.');
  const payload = JSON.stringify({ version: 1, stage: 'recheck', publicationOperationId: saved.operation.id });
  assertResourceBudget(db, request.workflowId, Buffer.byteLength(payload) + WORKFLOW_LIMITS.evidenceBytes);
  db.query("INSERT INTO operation_intents VALUES (?,?,'publication',?,'dispatching',?,NULL,0,NULL)")
    .run(id, request.attemptId, saved.operation.resourceKey, payload);
  return request.workflowId;
}

export async function recheckPublication(store: WorkflowStore, id: string, signal: AbortSignal,
  find: (saved: ReturnType<typeof savedPublication>, signal: AbortSignal) => Promise<WorkflowPublicationLookup>,
  options: { now(): string; onInvalidated(id: string, revision: number): void; wait?: (ms: number, signal: AbortSignal) => Promise<void> }) {
  let detail = 'Publication could not be confirmed; no write was repeated.';
  let observation: { value: NonNullable<WorkflowPublicationLookup['pulls'][number]>; observedInstanceId: string } | null = null;
  try {
    for (;;) {
      signal.throwIfAborted();
      const captured = store.transaction(db => {
        const operation = requireOperation(db, id);
        if (operation.status !== 'dispatching' || operation.reconcileCount >= 5) return null;
        const payload = JSON.parse(operation.payload) as { publicationOperationId: string };
        const saved = savedPublication(db, operation.attemptId, payload.publicationOperationId);
        const waitMs = operation.reconcileCount === 0 ? 0 : Math.min(300_000, 1000 * 2 ** (operation.reconcileCount - 1));
        db.query('UPDATE operation_intents SET reconcile_count=reconcile_count+1,next_reconcile_at=? WHERE id=?')
          .run(new Date(Date.parse(options.now()) + waitMs).toISOString(), id);
        return { saved, waitMs };
      });
      if (!captured) break;
      if (captured.waitMs) await (options.wait?.(captured.waitMs, signal) ?? delay(captured.waitMs, undefined, { signal }));
      try {
        const found = await find(captured.saved, signal);
        signal.throwIfAborted();
        if (found.executorId !== captured.saved.publication.executorId || !sameGhRepository(found.repository, captured.saved.publication.repository)
          || found.actor.id !== captured.saved.publication.actor.id || found.actor.login !== captured.saved.publication.actor.login) {
          detail = 'Publication repository or actor changed; recovery stopped.'; break;
        }
        if (found.pulls.length === 0) { detail = 'No matching pull request observed. The original create may still be running.'; continue; }
        let pull;
        try { pull = exactRecoveredPublication(found, captured.saved); }
        catch { detail = 'Conflicting publication identity requires operator attention.'; break; }
        store.read(db => {
          const current = savedPublication(db, captured.saved.attempt.attemptId, captured.saved.operation.id);
          if (workflowDigest(current.operation.payload) !== workflowDigest(captured.saved.operation.payload)) workflowConflict('Publication intent changed.');
        });
        observation = { value: pull, observedInstanceId: found.instanceId };
        detail = 'Exact open pull request found. Browser adoption is required to accept the task.';
        break;
      } catch { if (signal.aborted) break; }
    }
  } finally {
    const settled = store.transaction(db => {
      const operation = requireOperation(db, id);
      if (operation.status !== 'dispatching') return null;
      const attempt = requireAttempt(db, operation.attemptId);
      const result = JSON.stringify({ detail, observation });
      assertResourceBudget(db, attempt.workflowId, Buffer.byteLength(result) - WORKFLOW_LIMITS.evidenceBytes);
      db.query("UPDATE operation_intents SET status='succeeded',result_json=?,next_reconcile_at=NULL WHERE id=?")
        .run(result, id);
      appendWorkflowActivity(db, attempt.workflowId, 'publication-rechecked', 'engine', detail, options.now());
      return { id: attempt.workflowId, revision: workflowRevision(db) };
    });
    if (settled) options.onInvalidated(settled.id, settled.revision);
  }
}
