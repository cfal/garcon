import { Database } from 'bun:sqlite';
import type { ChatRunOutcome } from '../../../common/chat-activity.js';
import { isRecord } from '../../../common/json.js';
import { parseStoredJson } from '../../common/stored-json.js';
import type { LedgerActivityTask } from './activity-tasks.js';
import { UndecodableLedgerRowError } from './errors.js';

// Keeps JSON inspection and potentially large SQLite payloads on the activity Worker.
export function readLedgerRunOutcome(task: LedgerActivityTask): ChatRunOutcome | null {
  const db = new Database(task.databasePath, { readonly: true, create: false });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN');
    const current = db.query<{ view_id: string }, []>(
      "SELECT view_id FROM transcript_views WHERE status = 'current'",
    ).get();
    if (current?.view_id !== task.viewId) throw new Error('Transcript activity view was replaced');
    const rows = db.query<{
      kind: string; payloadJson: string | null; outcome: unknown; messageType: unknown;
    }, [string, number]>(`
      SELECT kind,
        CASE WHEN kind IN ('run-ended', 'provider-row') AND NOT json_valid(payload_json)
          THEN payload_json END AS payloadJson,
        CASE WHEN kind = 'run-ended' AND json_valid(payload_json)
          THEN json_extract(payload_json, '$.value.outcome') END AS outcome,
        CASE WHEN kind = 'provider-row' AND json_valid(payload_json)
          THEN json_extract(payload_json, '$.value.type') END AS messageType
      FROM transcript_rows
      WHERE view_id = ? AND ordinal < ?
      ORDER BY ordinal DESC
    `).iterate(task.viewId, task.beforeOrdinal);
    for (const row of rows) {
      let { outcome, messageType } = row;
      if (row.payloadJson !== null) {
        // SQLite's JSON nesting limit is lower than the primary ledger decoder's.
        let payload: unknown;
        try {
          payload = parseStoredJson(row.payloadJson, 'Ledger payload');
        } catch (error) {
          throw new UndecodableLedgerRowError({ cause: error });
        }
        if (isRecord(payload) && isRecord(payload.value)) {
          if (row.kind === 'run-ended') outcome = payload.value.outcome;
          else messageType = payload.value.type;
        }
      }
      if (row.kind === 'user-input' || messageType === 'user-message') return null;
      if (row.kind !== 'run-ended') continue;
      if (outcome === 'finished' || outcome === 'failed' || outcome === 'interrupted') return outcome;
      throw new UndecodableLedgerRowError();
    }
    return null;
  } finally {
    db.close();
  }
}
