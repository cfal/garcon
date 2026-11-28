import { UserMessage } from '../../../common/chat-types.ts';
import { transcriptViewId, type LedgerRowDraft } from '../../../server/controller/ledger/contracts.ts';
import { inputDetail } from '../../../server/controller/ledger/input-submission.ts';
import { encodeDrafts, materializeRows } from '../../../server/controller/ledger/staging-views.ts';

type Row = { kind: 'notice'; content: string } | { kind: 'input'; content: string; id: string | null };
const at = '2026-11-28T09:00:00.000Z';

function encode(rows: Row[]) {
  return encodeDrafts(rows.map((row): LedgerRowDraft => row.kind === 'notice'
    ? { kind: 'notice', at, message: row.content, detail: {} }
    : { kind: 'user-input', at, detail: inputDetail({
      message: new UserMessage(at, row.content), clientMessageId: row.id, attachments: [], steer: false,
    }) }));
}

export function encodeStagedDraftsFixture(rows: Row[]) {
  return encode(rows).map(({ clientMessageId, payloadJson }) => ({ clientMessageId, payloadJson }));
}

export function materializeStagedDraftsFixture(rows: Row[], viewId: string, firstOrdinal: number) {
  return JSON.parse(JSON.stringify(materializeRows(transcriptViewId(viewId), encode(rows), firstOrdinal)));
}
