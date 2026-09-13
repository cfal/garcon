import { expect, test } from 'bun:test';
import { parseNodeProviderHistoryCommand, parseNodeProviderHistoryReply, type NodeProviderHistoryCommand, type NodeProviderHistoryReply } from '../provider-history-wire.js';
import { MAX_NODE_HISTORY_ROW_BYTES, NODE_HISTORY_ROW_ENCODING } from '../provider-history-row.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const target = { identity: { ...session, operationId: 'synthetic-operation' }, instanceId: 'synthetic-instance', connectionId: 1, bulkAttemptId: 'synthetic-bulk' };
const descriptor = { byteLength: 1024, sha256: 'a'.repeat(64) };
const grant = { ...session, transferId: 'synthetic-transfer' };
const chat = { chatId: '1000000000000001', agentId: 'synthetic', agentSessionId: 'synthetic-session-id', model: '', nativeSession: null,
  carryOverRevision: '', nativeSeedReceipt: null, settings: null };
const open = { ...target, method: 'provider-history-import', operation: 'open', workspaceId: 'synthetic-workspace', facet: 'native', chat } as const;

test('strict history commands and replies preserve every cursor and physical identity', () => {
  const commands: NodeProviderHistoryCommand[] = [open, { ...open, facet: 'legacy' },
    { ...target, method: 'provider-history-import', operation: 'next', sequence: 1 },
    { ...target, method: 'provider-history-import', operation: 'transfer', sequence: 1, grant, descriptor },
    { ...target, method: 'provider-history-import', operation: 'cancel' }];
  const replies: NodeProviderHistoryReply[] = [
    { ...target, kind: 'provider-history-result', operation: 'opened' },
    { ...target, kind: 'provider-history-result', operation: 'row', sequence: 1, descriptor, encoding: NODE_HISTORY_ROW_ENCODING },
    { ...target, kind: 'provider-history-result', operation: 'eof', sequence: 2 },
    { ...target, kind: 'provider-history-result', operation: 'transferred', sequence: 1 },
    { ...target, kind: 'provider-history-result', operation: 'cancelled', settled: false },
    { ...target, kind: 'provider-history-result', operation: 'cancelled', settled: true },
    { ...target, kind: 'provider-history-result', operation: 'failed', code: 'NODE_HISTORY_MULTIPLE_FAILURES' },
  ];
  for (const command of commands) {
    expect(parseNodeProviderHistoryCommand(JSON.parse(JSON.stringify(command)))).toEqual(command);
    expect(parseNodeProviderHistoryCommand({ ...command, projectPath: '/controller/forbidden' })).toBeNull();
  }
  for (const reply of replies) {
    expect(parseNodeProviderHistoryReply(JSON.parse(JSON.stringify(reply)))).toEqual(reply);
    expect(parseNodeProviderHistoryReply({ ...reply, rows: [] })).toBeNull();
  }
});

test('history messages reject missing physical fencing, foreign grants, invalid sequence and oversized descriptors', () => {
  for (const key of ['identity', 'instanceId', 'connectionId', 'bulkAttemptId', 'facet', 'workspaceId', 'chat']) {
    const malformed: Record<string, unknown> = { ...open }; delete malformed[key];
    expect(parseNodeProviderHistoryCommand(malformed)).toBeNull();
  }
  for (const value of [-1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '1']) {
    expect(parseNodeProviderHistoryCommand({ ...target, method: 'provider-history-import', operation: 'next', sequence: value })).toBeNull();
    expect(parseNodeProviderHistoryCommand({ ...open, connectionId: value })).toBeNull();
  }
  const transfer = { ...target, method: 'provider-history-import', operation: 'transfer', sequence: 1, grant, descriptor };
  expect(parseNodeProviderHistoryCommand({ ...transfer, grant: { ...grant, nodeBootId: 'foreign' } })).toBeNull();
  for (const byteLength of [0, MAX_NODE_HISTORY_ROW_BYTES + 1]) {
    expect(parseNodeProviderHistoryCommand({ ...transfer, descriptor: { ...descriptor, byteLength } })).toBeNull();
    expect(parseNodeProviderHistoryReply({ ...target, kind: 'provider-history-result', operation: 'row', sequence: 1,
      encoding: NODE_HISTORY_ROW_ENCODING, descriptor: { ...descriptor, byteLength } })).toBeNull();
  }
  expect(parseNodeProviderHistoryCommand({ ...open, chat: { ...chat, projectPath: '/foreign' } })).toBeNull();
  expect(parseNodeProviderHistoryReply({ ...target, kind: 'provider-history-result', operation: 'failed', code: 'ARBITRARY_PROVIDER_ERROR' })).toBeNull();
});
