import type { Database } from 'bun:sqlite';
import type { WorkflowOperationIntent } from '../../../common/workflows.js';
import type { WorkflowEffectFence } from './contracts.js';
import { workflowConflict } from './errors.js';

export function requireResourceDispatch(db: Database, operation: WorkflowOperationIntent, fence: WorkflowEffectFence): void {
  if (fence.shutdown.aborted) workflowConflict('Resource dispatch was canceled by shutdown.');
  if (operation.status !== 'planned' || fence.revoked) workflowConflict('Resource dispatch is no longer authorized.');
  if (db.query("SELECT 1 FROM operation_intents WHERE attempt_id=? AND id!=? AND status IN ('dispatching','unknown','abandoned') LIMIT 1")
    .get(operation.attemptId, operation.id)) workflowConflict('Another resource mutation remains unsettled.');
  if (db.query('SELECT 1 FROM resource_claims WHERE attempt_id=? AND (quarantined=1 OR risk_released=1 OR retained=1)').get(operation.attemptId)) {
    workflowConflict('Resource is quarantined.');
  }
}

export function requireOperation(db: Database, operationId: string): WorkflowOperationIntent {
  const row = db.query<WorkflowOperationIntent, [string]>(`SELECT id,attempt_id AS attemptId,kind,resource_key AS resourceKey,status,payload_json AS payload,
    result_json AS result,reconcile_count AS reconcileCount,next_reconcile_at AS nextReconcileAt FROM operation_intents WHERE id=?`).get(operationId);
  if (!row) return workflowConflict('Resource operation does not exist.');
  return row;
}
