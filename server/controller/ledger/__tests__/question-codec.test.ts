import { describe, expect, it } from 'bun:test';
import { decodeLedgerRow, type StoredLedgerRow } from '../codec.js';
import { ledgerRowToMessage } from '../presentation.js';
import { parseChatMessage } from '../../../../common/chat-types.js';

const at = '2026-11-02T00:00:00.000Z';
const oldQuestion = {
  type: 'cursor-ask-question-tool-use',
  timestamp: at,
  toolId: 'question-call',
  title: 'Choose',
  questions: [{ id: 'mode', prompt: 'Which mode?', allowMultiple: true, options: [{ id: 'fast', label: 'Fast' }] }],
};
function stored(kind: StoredLedgerRow['kind'], value: unknown): StoredLedgerRow {
  return {
    view_id: 'view-one',
    ordinal: 1,
    kind,
    at,
    client_message_id: null,
    payload_json: JSON.stringify({ providerMeta: null, value }),
  };
}

describe('stored question messages', () => {
  it('decodes old Cursor provider and permission rows into the generic type without rewriting bytes', () => {
    const provider = stored('provider-row', oldQuestion);
    const permission = stored('permission-requested', {
      kind: 'requested',
      incarnation: 'occurrence-one',
      requestedTool: oldQuestion,
      options: [],
    });
    for (const row of [provider, permission]) {
      const original = row.payload_json;
      const decoded = ledgerRowToMessage(decodeLedgerRow(row));
      const question = decoded?.type === 'permission-request' ? decoded.requestedTool : decoded;
      expect(question).toMatchObject({ ...oldQuestion, type: 'ask-user-question-tool-use' });
      expect(row.payload_json).toBe(original);
    }
  });
  it('projects and round-trips durable submitted text with no pending capability', () => {
    const response = {
      type: 'ask-user-question-response',
      outcome: 'answered',
      answers: [{ questionId: 'mode', selectedOptionIds: [], text: 'Custom mode' }],
    };
    const decoded = ledgerRowToMessage(
      decodeLedgerRow(
        stored('permission-resolved', {
          kind: 'resolved',
          incarnation: 'occurrence-one',
          decision: { allow: true, response },
        }),
      ),
    );
    expect(decoded).toMatchObject({ type: 'permission-resolved', allowed: true, questionResponse: response });
    expect(parseChatMessage(JSON.parse(JSON.stringify(decoded)))).toEqual(decoded);
  });
});
