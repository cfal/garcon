import { expect, test } from 'bun:test';
import { parseChatMessage, ToolResultMessage } from '@garcon/common/chat-types';
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

test('indexes referenced output before long progress or attachments without changing stored block order', () => {
  const at = '2026-01-01T00:00:00Z';
  const block = (text: string) => ({ type: 'content', content: { type: 'text', text } });
  for (const [progress, refs] of [['Checking '.repeat(500), [2]], ['Checking', [0, 2]]] as const) {
    const content = { items: [block(progress), { type: 'image', data: 'A'.repeat(5000) }, block('Operation refused')], rawOutput: { attempts: 1 } };
    const message = new ToolResultMessage(at, 'timer', content, true, refs);
    const { payloadJson, clientMessageId } = encodeLedgerDraft({ kind: 'provider-row', at, message });
    const row = decodeLedgerRow({ kind: 'provider-row', at, ordinal: 1, view_id: 'view',
      client_message_id: clientMessageId, payload_json: payloadJson });
    if (row.kind !== 'provider-row' || row.message.type !== 'tool-result') throw new Error('Expected a tool result');
    expect(row.message.primaryTextItems).toEqual(refs);
    expect(row.message.content.items).toEqual(content.items);
    const body = projectSearchMessage(row.message)?.body ?? '';
    expect(body.startsWith(refs.length === 1 ? 'Operation refused' : 'Checking Operation refused')).toBe(true);
    expect(body.match(/Operation refused/g)).toHaveLength(1);
    expect(body.length).toBeLessThanOrEqual(2512);
    expect(parseChatMessage({ ...message, primaryTextItems: [9] })).toEqual(new ToolResultMessage(at, 'timer', content, true));
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
