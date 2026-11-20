import { Database } from 'bun:sqlite';
import type { ChatRunOutcome } from '../../../common/chat-activity.js';
import type { LedgerActivityTask } from './activity-tasks.js';
import { UndecodableLedgerRowError } from './errors.js';

// Keeps JSON inspection and potentially large SQLite payloads on the activity Worker.
export function readLedgerRunOutcome(task: LedgerActivityTask): ChatRunOutcome | null {
  const db = new Database(task.databasePath, { readonly: true, create: false });
  try {
    db.exec('BEGIN');
    const current = db.query<{ view_id: string }, []>(
      "SELECT view_id FROM transcript_views WHERE status = 'current'",
    ).get();
    if (current?.view_id !== task.viewId) throw new Error('Transcript activity view was replaced');
    const rows = db.query<{
      kind: string; outcome: string | null; messageType: string | null;
    }, [string, number]>(`
      SELECT kind,
        CASE WHEN kind = 'run-ended' THEN json_extract(payload_json, '$.value.outcome') END AS outcome,
        CASE WHEN kind = 'provider-row' THEN json_extract(payload_json, '$.value.type') END AS messageType
      FROM transcript_rows
      WHERE view_id = ? AND ordinal < ?
      ORDER BY ordinal DESC
    `).iterate(task.viewId, task.beforeOrdinal);
    for (const row of rows) {
      if (row.kind === 'user-input' || row.messageType === 'user-message') return null;
      if (row.kind !== 'run-ended') continue;
      if (row.outcome === 'finished' || row.outcome === 'failed' || row.outcome === 'interrupted') return row.outcome;
      throw new UndecodableLedgerRowError();
    }
    return null;
  } finally {
    db.close();
  }
}
