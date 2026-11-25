import { expect, test } from 'bun:test';
import { ToolResultMessage } from '@garcon/common/chat-types';
import { projectSearchMessage } from '@garcon/server-agent-common/search/message-projector';
import { decodeLedgerRow, encodeLedgerDraft } from '../../../ledger/codec.js';

test.each([
  { reason: 'Operation refused' },
  { details: 'metadata '.repeat(500), output: 'Operation refused' },
])('indexes the structured diagnostic before supplementary data after ledger serialization', rawOutput => {
  const at = '2026-01-01T00:00:00Z';
  const message = new ToolResultMessage(at, 'task', { rawOutput,
    items: [{ type: 'text', text: 'working '.repeat(500) }], status: 'failed' }, true);
  const { payloadJson, clientMessageId } = encodeLedgerDraft({ kind: 'provider-row', at, message });
  const row = decodeLedgerRow({ kind: 'provider-row', at, ordinal: 1, view_id: 'view',
    client_message_id: clientMessageId, payload_json: payloadJson });
  if (row.kind !== 'provider-row') throw new Error('Expected a provider row');
  const body = projectSearchMessage(row.message)?.body;
  expect(body).toContain('Operation refused');
  expect(body!.length).toBeLessThanOrEqual(2512);
});
