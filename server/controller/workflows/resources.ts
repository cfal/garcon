import type { Database } from 'bun:sqlite';
import { WORKFLOW_LIMITS, type WorkflowOperationIntent } from '../../../common/workflows.js';
import { releaseSettledClaims, requireWorkflowDispatch } from './attempts.js';
import type { WorkflowEffectFence } from './contracts.js';
import { workflowConflict } from './errors.js';
import { appendWorkflowActivity, readPlan, requireAttempt } from './records.js';
import { workflowCommitInputIds } from './inputs.js';
import { requireOperation, requireResourceDispatch } from './resource-dispatch.js';
import type { WorkflowStore } from './store.js';

export class WorkflowResources {
  constructor(readonly store: WorkflowStore, private readonly now: () => string) {}

  plan(input: { readonly operationId: string; readonly attemptId: string;
    readonly kind: WorkflowOperationIntent['kind']; readonly resourceKey: string; readonly payload: string;
    readonly executorId?: string }): WorkflowOperationIntent {
    if (Buffer.byteLength(input.payload) > WORKFLOW_LIMITS.evidenceBytes || !input.resourceKey || input.resourceKey.length > 4096) {
      workflowConflict('Resource operation exceeds its bound.');
    }
    return this.store.transaction(db => {
      const attempt = requireAttempt(db, input.attemptId);
      requireWorkflowDispatch(db, attempt);
      if (!attempt.target) workflowConflict('Resource operation requires an executor-qualified target.');
      const executorId = input.executorId ?? attempt.target.executorId;
      if (executorId !== attempt.target.executorId) {
        const plan = readPlan(db, attempt.workflowId, attempt.planRevision).plan;
        const task = plan.tasks.find(task => task.id === attempt.taskId)!;
        const sources = workflowCommitInputIds(task);
        if (input.kind !== 'transfer' || !plan.tasks.some(source => sources.includes(source.id)
          && 'target' in source.spec && source.spec.target.executorId === executorId)) {
          workflowConflict('Resource executor is not an approved commit source.');
        }
      }
      if (db.query('SELECT 1 FROM operation_intents WHERE id=?').get(input.operationId)) {
        workflowConflict('Resource operation identity was already used.');
      }
      const count = db.query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM operation_intents WHERE attempt_id=?').get(input.attemptId)!.count;
      if (count >= WORKFLOW_LIMITS.resourceOperations) workflowConflict('Resource operation limit reached.');
      assertResourceBudget(db, attempt.workflowId, Buffer.byteLength(input.payload) + WORKFLOW_LIMITS.evidenceBytes);
      const owner = db.query<{ attempt_id: string }, [string]>('SELECT attempt_id FROM resource_claims WHERE resource_key=?').get(input.resourceKey);
      if (owner && owner.attempt_id !== input.attemptId) workflowConflict('Resource belongs to another attempt.');
      if (db.query("SELECT 1 FROM operation_intents WHERE attempt_id=? AND status IN ('dispatching','unknown','abandoned') LIMIT 1").get(input.attemptId)) {
        workflowConflict('Resolve the previous resource operation before another mutation.');
      }
      db.query('INSERT INTO resource_claims (resource_key,attempt_id,executor_id,quarantined,risk_released) VALUES (?,?,?,0,0) ON CONFLICT(resource_key) DO NOTHING')
        .run(input.resourceKey, input.attemptId, executorId);
      db.query("INSERT INTO operation_intents VALUES (?,?,?,?,'planned',?,NULL,0,NULL)")
        .run(input.operationId, input.attemptId, input.kind, input.resourceKey, input.payload);
      appendWorkflowActivity(db, attempt.workflowId, 'resource-planned', 'engine', input.operationId, this.now());
      return requireOperation(db, input.operationId);
    });
  }

  begin(operationId: string, fence: WorkflowEffectFence): WorkflowOperationIntent {
    return this.store.transaction(db => {
      const operation = requireOperation(db, operationId);
      const attempt = requireAttempt(db, operation.attemptId);
      requireWorkflowDispatch(db, attempt);
      requireResourceDispatch(db, operation, fence);
      if (operation.kind === 'integrate') workflowConflict('Integration dispatch must advance its attempt atomically.');
      if (operation.kind === 'publication' && attempt.dispatchPhase !== 'dispatching') workflowConflict('Publication dispatch must advance its attempt atomically.');
      db.query("UPDATE operation_intents SET status='dispatching' WHERE id=?").run(operationId);
      appendWorkflowActivity(db, attempt.workflowId, 'resource-dispatching', 'engine', operationId, this.now());
      return requireOperation(db, operationId);
    });
  }

  observe(operationId: string, status: 'succeeded' | 'not-started' | 'unknown', result: string): WorkflowOperationIntent {
    if (Buffer.byteLength(result) > WORKFLOW_LIMITS.evidenceBytes) workflowConflict('Resource result exceeds its bound.');
    return this.store.transaction(db => {
      const operation = requireOperation(db, operationId);
      if (operation.status !== 'dispatching' && operation.status !== 'unknown'
        && !(operation.status === 'planned' && status === 'not-started')) workflowConflict('Resource operation already settled.');
      if (operation.status === 'unknown' && status === 'not-started') {
        workflowConflict('A missing resource does not prove an earlier operation was never dispatched.');
      }
      const attempt = requireAttempt(db, operation.attemptId);
      assertResourceBudget(db, attempt.workflowId, Buffer.byteLength(result)
        - (operation.result === null ? WORKFLOW_LIMITS.evidenceBytes : Buffer.byteLength(operation.result)));
      db.query('UPDATE operation_intents SET status=?,result_json=? WHERE id=?').run(status, result, operationId);
      if (status === 'unknown') db.query('UPDATE resource_claims SET quarantined=1 WHERE attempt_id=?').run(operation.attemptId);
      if (attempt.dispatchPhase === 'settled' && attempt.controlState !== 'leased'
        && (attempt.resolution === 'not-started' || attempt.result?.termination === 'observed'
        && ['failed', 'interrupted'].includes(attempt.resolution))) releaseSettledClaims(db, operation.attemptId);
      appendWorkflowActivity(db, attempt.workflowId, 'resource-observed', 'engine', operationId, this.now());
      return requireOperation(db, operationId);
    });
  }

  get(operationId: string): WorkflowOperationIntent { return this.store.read(db => requireOperation(db, operationId)); }

  preflight(attemptId: string, operations: number, bytes: number): void {
    this.store.read(db => {
      const attempt = requireAttempt(db, attemptId);
      requireWorkflowDispatch(db, attempt);
      const count = db.query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM operation_intents WHERE attempt_id=?').get(attemptId)!.count;
      if (count + operations > WORKFLOW_LIMITS.resourceOperations) workflowConflict('Resource operation limit reached.');
      assertResourceBudget(db, attempt.workflowId, bytes);
    });
  }

  interruptPreparation(attemptId: string): void {
    this.store.transaction(db => {
      db.query("UPDATE operation_intents SET status='unknown' WHERE attempt_id=? AND status='dispatching'").run(attemptId);
      db.query("UPDATE operation_intents SET status='not-started' WHERE attempt_id=? AND status='planned'").run(attemptId);
      if (db.query("SELECT 1 FROM operation_intents WHERE attempt_id=? AND status='unknown'").get(attemptId)) {
        db.query('UPDATE resource_claims SET quarantined=1 WHERE attempt_id=?').run(attemptId);
      }
    });
  }
}

export function assertResourceBudget(db: Database, workflowId: string, additionalBytes: number): void {
  const { bytes } = db.query<{ bytes: number }, [string]>(`SELECT COALESCE(SUM(length(CAST(o.payload_json AS BLOB))
    +CASE WHEN o.result_json IS NOT NULL THEN length(CAST(o.result_json AS BLOB))
      WHEN o.status IN ('planned','dispatching','unknown') THEN ${WORKFLOW_LIMITS.evidenceBytes} ELSE 0 END),0) AS bytes
    FROM operation_intents o JOIN attempts a ON a.id=o.attempt_id
    WHERE a.workflow_id=?`).get(workflowId)!;
  if (bytes + additionalBytes > WORKFLOW_LIMITS.workflowResourceBytes) workflowConflict('Workflow resource metadata limit reached.');
}
