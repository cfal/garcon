import type { Database } from 'bun:sqlite';
import { createPreamblePrefix } from '../../common/preamble-prefix.js';
import {
  renderPreambleContent,
  type PendingPreambleBoundary,
  type Preamble,
} from '../../common/preambles.js';
import type {
  LedgerRowDraft,
  LedgerUserInputDetail,
  TranscriptViewId,
} from './contracts.js';

export interface PreparedPreambleInput {
  readonly detail: LedgerUserInputDetail;
  readonly drafts: readonly LedgerRowDraft[];
  readonly providerPrefix: string;
}

export function hasPreambleBoundaryProof(
  db: Database,
  viewId: TranscriptViewId,
  boundary: PendingPreambleBoundary,
): boolean {
  // The proof identity must match completely: a selection-change boundary in
  // one ownership epoch is repeatable per selection revision.
  if (boundary.kind === 'selection-change') {
    return Boolean(db.query<{ found: 1 }, [string, string, string, number]>(`
      SELECT 1 AS found
      FROM transcript_rows
      WHERE view_id = ? AND kind = 'user-input'
        AND json_extract(payload_json, '$.value.preambleBoundary.kind') = ?
        AND json_extract(payload_json, '$.value.preambleBoundary.ownershipEpoch') = ?
        AND json_extract(payload_json, '$.value.preambleBoundary.selectionRevision') = ?
      LIMIT 1
    `).get(viewId, boundary.kind, boundary.ownershipEpoch, boundary.selectionRevision));
  }
  return Boolean(db.query<{ found: 1 }, [string, string, string]>(`
    SELECT 1 AS found
    FROM transcript_rows
    WHERE view_id = ? AND kind = 'user-input'
      AND json_extract(payload_json, '$.value.preambleBoundary.kind') = ?
      AND json_extract(payload_json, '$.value.preambleBoundary.ownershipEpoch') = ?
    LIMIT 1
  `).get(viewId, boundary.kind, boundary.ownershipEpoch));
}

export function preparePreambleInput(input: {
  readonly chatId: string;
  readonly viewId: TranscriptViewId;
  readonly at: string;
  readonly detail: LedgerUserInputDetail;
  readonly boundary: PendingPreambleBoundary | null;
  readonly preambles: readonly Preamble[];
}): PreparedPreambleInput {
  if (input.boundary && !input.detail.clientMessageId) {
    throw new TypeError('Boundary input requires a client message ID');
  }
  const application = input.boundary
    ? createPreamblePrefix({
        contents: input.preambles.map((preamble) => (
          renderPreambleContent(preamble.content, input.chatId)
        )),
      })
    : null;
  const detail: LedgerUserInputDetail = {
    ...input.detail,
    preambleBoundary: input.boundary,
    preamblePrefixReceipt: application?.receipt ?? null,
  };
  validateInputDetail(detail);
  const drafts: LedgerRowDraft[] = application
    ? [
        {
          kind: 'notice',
          at: input.at,
          message: 'Preambles applied',
          detail: {
            type: 'preamble-application',
            preambles: input.preambles.map(({ id, title }) => ({ id, title })),
          },
          providerMeta: null,
        },
        { kind: 'user-input', at: input.at, detail, providerMeta: null },
      ]
    : [{ kind: 'user-input', at: input.at, detail, providerMeta: null }];
  return { detail, drafts, providerPrefix: application?.prefix ?? '' };
}

function validateInputDetail(detail: LedgerUserInputDetail): void {
  if (detail.clientMessageId !== null && detail.clientMessageId.length === 0) {
    throw new TypeError('Client message ID must be non-empty');
  }
  if (!detail.message || detail.message.type !== 'user-message') {
    throw new TypeError('Input detail requires a user message');
  }
  if (detail.preamblePrefixReceipt && !detail.preambleBoundary) {
    throw new TypeError('Preamble prefix receipt requires a boundary proof');
  }
}
