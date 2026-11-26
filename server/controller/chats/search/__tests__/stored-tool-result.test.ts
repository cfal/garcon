import { expect, test } from 'bun:test';
import { ToolResultMessage } from '@garcon/common/chat-types';
import { projectSearchMessage } from '@garcon/server-agent-common/search/message-projector';
import { decodeLedgerRow, encodeLedgerDraft } from '../../../ledger/codec.js';

test('empty successful result envelopes have no search target', () => {
  for (const content of [{ items: [] }, { content: [{ type: 'text', text: ' \t\n' }] }]) {
    expect(projectSearchMessage(new ToolResultMessage('', 'call', content, false))).toBeNull();
    expect(projectSearchMessage(new ToolResultMessage('', 'call', content, true))).not.toBeNull();
  }
  for (const content of [{ items: [], count: 0 }, { content: [{ type: 'text', text: 'Done' }] }]) {
    expect(projectSearchMessage(new ToolResultMessage('', 'call', content, false))).not.toBeNull();
  }
});

test.each([
  { reason: 'Operation refused' },
  { details: 'metadata '.repeat(500), output: 'Operation refused' },
  { error: 'Operation refused', output: ' \t\n'.repeat(1000) },
  { error: 'Operation refused', output: 'Working' + ' '.repeat(3000) },
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
