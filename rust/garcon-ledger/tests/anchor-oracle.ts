import { Database } from 'bun:sqlite';
import { AssistantMessage } from '../../../common/chat-types.ts';
import { readAnchorBatch, readAnchorPage, type AnchorScanInput } from '../../../server/controller/ledger/anchor-page.ts';
import { createSchema } from '../../../server/controller/ledger/connection-setup.ts';
import { transcriptViewId, type LedgerRowDraft } from '../../../server/controller/ledger/contracts.ts';
import { encodeDrafts, insertEncodedRows } from '../../../server/controller/ledger/staging-views.ts';

type Fixture = Pick<AnchorScanInput, 'direction' | 'anchorsRemaining'> & {
  layout: string;
  cursorOrdinal?: number;
  watermarkOrdinal?: number;
  gapOrdinal?: number;
  pauseAfter?: number;
};

const at = '2026-11-28T09:00:00.000Z';
const view = transcriptViewId('anchor-view');

function setup(fixture: Fixture) {
  const db = new Database(':memory:');
  createSchema(db);
  db.query('INSERT INTO transcript_views VALUES (?, ?, ?, ?)').run(view, 'current', at, 1);
  const drafts = Array.from(fixture.layout, (kind, i): LedgerRowDraft => {
    if (kind === 'a') return { kind: 'provider-row', at, message: new AssistantMessage(at, `anchor ${i}`) };
    if (kind === 'h') return { kind: 'run-ended', at, origin: 'core', outcome: 'finished' };
    return { kind: 'notice', at, message: `notice ${i}`, detail: {} };
  });
  insertEncodedRows(db, view, encodeDrafts(drafts), 1);
  if (fixture.gapOrdinal !== undefined) {
    db.query('DELETE FROM transcript_rows WHERE view_id = ? AND ordinal = ?').run(view, fixture.gapOrdinal);
  }
  const { direction, anchorsRemaining } = fixture;
  const watermarkOrdinal = fixture.watermarkOrdinal ?? drafts.length;
  const cursorOrdinal = fixture.cursorOrdinal ?? (direction === 'backward' ? watermarkOrdinal + 1 : 0);
  return { db, input: { direction, cursorOrdinal, watermarkOrdinal, anchorsRemaining } };
}

export function anchorBatchFixture(fixture: Fixture) {
  const { db, input } = setup(fixture);
  try {
    let checked = 0;
    const result = readAnchorBatch(db, view, input, input, () => ++checked >= (fixture.pauseAfter ?? Infinity));
    return JSON.parse(JSON.stringify(result));
  } finally {
    db.close();
  }
}

export async function anchorPageFixture(fixture: Fixture) {
  const { db, input } = setup(fixture);
  try {
    return JSON.parse(JSON.stringify(await readAnchorPage(view, input, work => work(db))));
  } finally {
    db.close();
  }
}
