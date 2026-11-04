import { setImmediate } from 'node:timers/promises';
import type { WorkflowAttemptResult } from '../../../common/workflows.js';
import { holdTask, releaseSettledClaims } from './attempts.js';
import { appendWorkflowActivity, requireAttempt } from './records.js';
import type { WorkflowStore } from './store.js';

export async function recoverWorkflowAttempts(store: WorkflowStore, now: () => string): Promise<number> {
  await recoverResourceOperations(store, now);
  let recovered = 0;
  for (;;) {
    const count = store.transaction(db => {
      const rows = db.query<{ id: string }, []>("SELECT id FROM attempts WHERE resolution='open' OR control_state='leased' OR dispatch_phase!='settled' ORDER BY rowid LIMIT 32").all();
      for (const { id } of rows) {
        const attempt = requireAttempt(db, id);
        if (attempt.resolution === 'succeeded') {
          db.query("UPDATE attempts SET dispatch_phase='settled',control_state=? WHERE id=?")
            .run(attempt.controlState === 'revoked' ? 'revoked' : 'released', id);
          if (attempt.revocationKind === 'intervention') holdTask(db, attempt, 'intervention', attempt.revocationReason ?? 'Attempt control was interrupted.');
          releaseSettledClaims(db, id);
          appendWorkflowActivity(db, attempt.workflowId, 'accepted-attempt-recovered', 'engine', id, now());
          continue;
        }
        const notStarted = !attempt.result && ['planned', 'preparing', 'prepared'].includes(attempt.dispatchPhase);
        const detail = notStarted ? 'Controller restarted before dispatch.'
          : attempt.result ? 'Terminal survived, but output observation did not.' : 'Controller restarted with an unresolved dispatch.';
        const result: WorkflowAttemptResult = attempt.result ?? { certainty: notStarted ? 'not-started' : 'unknown', detail,
          commandOutcome: null, receivedOutputCoverage: 'unknown', outputCaptured: false,
          termination: notStarted ? 'not-started' : 'unknown' };
        db.query(`UPDATE attempts SET resolution=?,dispatch_phase='settled',control_state=?,result_json=? WHERE id=?`)
          .run(notStarted ? 'not-started' : 'unknown', attempt.controlState === 'revoked' ? 'revoked' : 'released', JSON.stringify(result), id);
        if (attempt.revocationKind === 'intervention') holdTask(db, attempt, 'intervention', attempt.revocationReason ?? detail);
        else if (!notStarted) holdTask(db, attempt, 'output-unknown', detail);
        if (notStarted) {
          releaseSettledClaims(db, id);
          db.query('UPDATE tasks SET next_eligible_at=? WHERE workflow_id=? AND id=?')
            .run(new Date(Date.parse(now()) + 1000).toISOString(), attempt.workflowId, attempt.taskId);
        } else db.query('UPDATE resource_claims SET quarantined=1 WHERE attempt_id=?').run(id);
        appendWorkflowActivity(db, attempt.workflowId, 'attempt-recovered', 'engine', id, now());
      }
      return rows.length;
    });
    recovered += count;
    if (count < 32) return recovered;
    await setImmediate();
  }
}

async function recoverResourceOperations(store: WorkflowStore, now: () => string): Promise<void> {
  for (;;) {
    const count = store.transaction(db => {
      const rows = db.query<{ id: string; attempt_id: string; status: 'planned' | 'dispatching' }, []>(
        "SELECT id,attempt_id,status FROM operation_intents WHERE status IN ('planned','dispatching') ORDER BY rowid LIMIT 32",
      ).all();
      for (const operation of rows) {
        db.query('UPDATE operation_intents SET status=? WHERE id=?')
          .run(operation.status === 'planned' ? 'not-started' : 'unknown', operation.id);
        if (operation.status === 'dispatching') db.query('UPDATE resource_claims SET quarantined=1 WHERE attempt_id=?').run(operation.attempt_id);
        appendWorkflowActivity(db, requireAttempt(db, operation.attempt_id).workflowId, 'resource-recovered', 'engine', operation.id, now());
      }
      return rows.length;
    });
    if (count < 32) return;
    await setImmediate();
  }
}

export function suspendWorkflowAdmission(store: WorkflowStore): number {
  return store.transaction(db => {
    db.query('UPDATE workflow_metadata SET admission_epoch=admission_epoch+1,revision=revision+1 WHERE singleton=1').run();
    return db.query<{ admission_epoch: number }, []>('SELECT admission_epoch FROM workflow_metadata WHERE singleton=1').get()!.admission_epoch;
  });
}
