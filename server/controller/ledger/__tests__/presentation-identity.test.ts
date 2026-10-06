import { describe, expect, it } from 'bun:test';
import { UserMessage } from '../../../../common/chat-types.js';
import { ledgerRowToMessage, ledgerRowsToTranscriptMessages } from '../presentation.js';
import { transcriptViewId, type LedgerRow, type LedgerUserInputRow } from '../contracts.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const base = { viewId: transcriptViewId('synthetic-view'), ordinal: 1, at: timestamp, providerMeta: null };

function input(clientMessageId: string | null, message: UserMessage): LedgerUserInputRow {
  return {
    ...base, kind: 'user-input',
    detail: { clientMessageId, message, attachments: [], steer: false, preambleBoundary: null, preamblePrefixReceipt: null },
  };
}

describe('public transcript submission identity', () => {
  it('projects only the indexed identity without mutating canonical content or metadata', () => {
    const message = new UserMessage(timestamp, 'Synthetic body', undefined, {
      clientMessageId: 'untrusted-input', upstreamRequestId: 'synthetic-upstream',
    });
    const presented = ledgerRowToMessage(input('indexed-input', message));
    expect(presented).toEqual(new UserMessage(timestamp, 'Synthetic body', undefined, {
      clientMessageId: 'indexed-input', upstreamRequestId: 'synthetic-upstream',
    }));
    expect(message.metadata?.clientMessageId).toBe('untrusted-input');
  });

  it('[TLV5-L04.07-PRESENTATION-UNIT-01] does not let imported or provider metadata alias separate durable rows or pending inputs', () => {
    const message = new UserMessage(timestamp, 'Synthetic repeated body', undefined, { clientMessageId: 'reused-native-id' });
    const rows: LedgerRow[] = [
      input(null, message),
      { ...input(null, message), ordinal: 2 },
      { ...base, ordinal: 3, kind: 'provider-row', message },
    ];
    const presented = ledgerRowsToTranscriptMessages(rows);
    expect(presented.map((row) => row.ordinal)).toEqual([1, 2, 3]);
    expect(presented.map((row) => row.message)).toEqual([
      new UserMessage(timestamp, 'Synthetic repeated body'),
      new UserMessage(timestamp, 'Synthetic repeated body'),
      new UserMessage(timestamp, 'Synthetic repeated body'),
    ]);
    expect(message.metadata?.clientMessageId).toBe('reused-native-id');
  });

  it('retains ordinary user content, attachments, presentation, and unrelated metadata', () => {
    const message = new UserMessage(timestamp, 'Synthetic body', [{ name: 'synthetic.txt', data: 'data:text/plain;base64,YQ==' }], {
      clientMessageId: 'native-id', clientRequestId: 'request-1', turnId: 'turn-1',
    }, { origin: 'cli', disclosure: 'collapsed' });
    const presented = ledgerRowToMessage(input(null, message));
    expect(presented).toEqual(new UserMessage(timestamp, message.content, message.images, {
      clientRequestId: 'request-1', turnId: 'turn-1',
    }, message.presentation));
  });
});
