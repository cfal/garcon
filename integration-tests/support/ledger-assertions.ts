import { Database } from 'bun:sqlite';
import { join } from 'node:path';

export interface InterruptedTerminal {
  readonly transcriptViewId: string;
  readonly ordinal: number;
}

// Raw message reads omit lifecycle rows and can include content committed after the terminal.
export function latestInterruptedTerminal(workspace: string, chatId: string): InterruptedTerminal {
  const db = new Database(join(workspace, 'transcript-ledgers', chatId, 'ledger.sqlite'), { readonly: true });
  try {
    const terminal = db.query<InterruptedTerminal, []>(`
      SELECT r.view_id AS transcriptViewId, r.ordinal
      FROM transcript_rows r JOIN transcript_views v ON v.view_id = r.view_id
      WHERE v.status = 'current' AND r.kind = 'run-ended'
        AND json_extract(r.payload_json, '$.value.outcome') = 'interrupted'
      ORDER BY r.ordinal DESC LIMIT 1
    `).get();
    if (!terminal) throw new Error(`No interrupted terminal committed for ${chatId}`);
    return terminal;
  } finally { db.close(); }
}
