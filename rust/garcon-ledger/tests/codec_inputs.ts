import type { StoredLedgerRow } from '../../../server/controller/ledger/codec.ts';

const at = '2026-11-28T09:00:00.000Z';
const view = '00000000-0000-4000-8000-000000000001';
const occurrence = '11111111-1111-4111-8111-111111111111';
const receipt = { format: 'preamble-v1', codeUnitLength: 5, sha256: 'a'.repeat(64) };
const calls: {fn: string; args: unknown[]}[] = [];
const call = (fn: string, ...args: unknown[]) => calls.push({ fn, args });
const row = (kind: StoredLedgerRow['kind'], value: unknown, client: string | null = null,
  providerMeta: unknown = null): StoredLedgerRow => ({
  view_id: view,
  ordinal: 1,
  kind,
  at,
  client_message_id: client,
  payload_json: JSON.stringify({ providerMeta, value }),
});

const input = {
  clientMessageId: 'synthetic-user',
  message: {
    type: 'user-message', timestamp: at, content: 'Synthetic input \u{1F331}',
    images: [{ data: 'c3ludGhldGlj', name: 'image.png' }],
    metadata: { clientRequestId: 'request', contentFormat: 'plain' },
  },
  attachments: [{ kind: 'image', data: 'c3ludGhldGlj', name: null, mimeType: 'image/png' }],
  steer: false,
  preambleBoundary: null,
  preamblePrefixReceipt: null,
};
const cli = {
  type: 'cli-row', clientMessageId: 'synthetic-cli',
  presentation: {
    customStyle: { darkAccent: '#abcfff', lightAccent: '#abc000' },
    style: 'custom',
  },
  title: 'Synthetic title', format: 'plain', disclosure: 'collapsed',
};
const selection = {
  type: 'preamble-selection-change', clientMessageId: 'synthetic-selection',
  requestFingerprint: 'synthetic-fingerprint', selectionRevision: 3,
  preambles: [{ title: 'Example', id: '00000000-0000-4000-8000-000000000002' }],
};
const providerMessage = { type: 'assistant-message', timestamp: at, content: 'Synthetic answer' };
const session = { agentSessionId: 'synthetic-session', nativeSession: null, nativeSeedReceipt: null };
const nativeSeedReceipt = {
  agentSessionId: session.agentSessionId,
  placement: 'user-prefix',
  format: 'v3-xml',
  codeUnitLength: 5,
  sha256: 'c'.repeat(64),
};
const requested = {
  kind: 'requested', incarnation: occurrence,
  requestedTool: { type: 'bash-tool-use', timestamp: at, toolId: 'synthetic-tool', command: 'pwd' },
  options: [{ id: 'allow', label: 'Allow', extra: { n: 1e21 } }],
  reason: 'Synthetic reason',
};
const resolved = {
  kind: 'resolved', incarnation: occurrence,
  decision: { allow: true, alwaysAllow: false, response: { z: 1e-7, a: 1e21 } },
};

const good = [
  row('user-input', input, input.clientMessageId),
  row('user-input', { ...input, clientMessageId: null, preambleBoundary: undefined, preamblePrefixReceipt: undefined }),
  row('provider-row', providerMessage, null, { '\uE000': 2, '\u{1F9EA}': 1, 10: 10, 2: 2, decimal: 1e21 }),
  row('notice', { message: 'Synthetic notice', detail: { type: 'chat-id-request' } }),
  row('notice', { message: 'Synthetic body', detail: cli }, cli.clientMessageId),
  row('notice', { message: 'Preambles updated', detail: selection }, selection.clientMessageId),
  row('agent-switch', { fromExecutorId: 'local', fromAgentId: 'a', toAgentId: 'b', fromModel: 'm', toModel: null }),
  row('session', session),
  row('session', { ...session, nativeSession: { ownerId: 'synthetic-agent', schemaVersion: 1, value: { data: [1, null] } } }),
  row('session', { ...session, nativeSeedReceipt }),
  row('run-ended', { outcome: 'finished', origin: 'provider' }),
  row('run-ended', { outcome: 'failed', origin: 'core', error: { code: 'SYNTHETIC', message: 'Synthetic failure' } }),
  row('permission-requested', requested),
  row('permission-resolved', resolved),
  row('permission-cancelled', { kind: 'cancelled', incarnation: occurrence, reason: null }),
  row('permission-expired', { kind: 'expired', incarnation: occurrence }),
];
for (const stored of good) {
  call('decodeLedgerRow', stored);
  call('decodeStoredLedgerRow', stored);
  call('encodeDecodedLedgerDraft', stored);
  call('classifyDecodedLedgerRow', stored);
}
call('classifyDecodedLedgerRow', row('provider-row', {
  type: 'error', timestamp: at, content: 'Synthetic error',
}));
call('decodeClonedStoredRows', good);
call('decodeClonedStoredRows', []);
call('decodeClonedStoredRows', [good[0], { payload_json: null }]);
call('decodeClonedStoredRows', [null]);
call('decodeClonedStoredRows', [{ ...good[0], ordinal: null }]);
call('decodeClonedStoredRows', [{ ...good[0], payload_json: 'not JSON' }]);
for (const kind of [123, null, true, ['provider-row'], { synthetic: true }, undefined]) {
  call('decodeClonedStoredRows', [{ ...good[2], kind }]);
}
call('decodeClonedStoredRows', [{ ...good[2], kind: 123, ordinal: 0 }]);
call('fingerprintDecodedSubmission', good[0]);
call('fingerprintDecodedSubmission', good[1]);
call('fingerprintDecodedSubmission', good[2]);
call('fingerprintDecodedSubmission', row('user-input',
  { ...input, steer: true, attachments: [], message: { ...input.message, images: null, metadata: null } },
  input.clientMessageId));
for (const presentation of [
  { origin: 'cli', style: 'notice' },
  { origin: 'cli', style: 'error' },
  { origin: 'cli', style: 'info' },
  { origin: 'cli', style: 'notice', title: 'A' },
  { origin: 'cli', style: 'notice', title: 'B' },
  { origin: 'cli', style: 'custom', customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' } },
  { origin: 'cli', style: 'custom', customStyle: { lightAccent: '#0ea5e9', darkAccent: '#c4b5fd' } },
]) {
  call('fingerprintDecodedSubmission', row('user-input', {
    ...input, message: { ...input.message, presentation },
  }, input.clientMessageId));
}

for (const malformed of [
  { ...good[0], payload_json: 'not JSON', ordinal: 0, at: '' },
  { ...good[0], payload_json: '[]' },
  { ...good[0], payload_json: '{"value":{}}' },
  { ...good[0], ordinal: 0, at: '' },
  { ...good[0], ordinal: 1.5 },
  { ...good[0], ordinal: 2 ** 53 },
  { ...good[0], at: '' },
  { ...good[0], kind: 'unknown' },
  row('user-input', input, 'other'),
  row('user-input', { ...input, message: providerMessage }, input.clientMessageId),
  row('user-input', { ...input, clientMessageId: undefined }),
  row('user-input', { ...input, attachments: {} }, input.clientMessageId),
  row('user-input', { ...input, attachments: [{ kind: 'text', data: '', name: '', mimeType: '' }] }, input.clientMessageId),
  row('user-input', { ...input, attachments: [{ kind: 'image', data: '', name: '', mimeType: '' }] }, input.clientMessageId),
  row('user-input', { ...input, steer: 1 }, input.clientMessageId),
  row('user-input', { ...input, preambleBoundary: 'bad', preamblePrefixReceipt: 'also bad' }, input.clientMessageId),
  row('user-input', { ...input, preamblePrefixReceipt: {} }, input.clientMessageId),
  row('user-input', { ...input, preamblePrefixReceipt: receipt }, input.clientMessageId),
  row('provider-row', { type: 'unknown' }),
  row('provider-row', { ...input.message, metadata: { questionReply: {} } }),
  row('notice', { message: '', detail: null }, 'other'),
  row('notice', { message: 'Synthetic notice', detail: null }, 'other'),
  row('notice', { message: 'Synthetic notice', detail: {} }, 'other'),
  row('notice', { message: 'Synthetic notice', detail: cli }, 'other', {}),
  row('notice', { message: 'Synthetic notice', detail: cli }, cli.clientMessageId, {}),
  row('notice', { message: 'Synthetic notice', detail: selection }, 'other', {}),
  row('notice', { message: 'Synthetic notice', detail: selection }, selection.clientMessageId, {}),
  row('agent-switch', { fromExecutorId: 'bad' }),
  row('session', { ...session, nativeSession: undefined, nativeSeedReceipt: 'bad' }),
  row('session', { ...session, nativeSession: { ownerId: 'x', schemaVersion: 0, value: null } }),
  row('session', { ...session, nativeSeedReceipt: undefined }),
  row('session', { ...session, nativeSeedReceipt: { ...nativeSeedReceipt, agentSessionId: 'different' } }),
  row('run-ended', { outcome: 'bad', origin: 'bad', error: null }),
  row('run-ended', { outcome: 'failed', origin: 'bad', error: null }),
  row('run-ended', { outcome: 'failed', origin: 'core', error: { message: null } }),
  row('permission-requested', { ...requested, incarnation: undefined, permissionOccurrenceId: occurrence }),
  row('permission-requested', { ...requested, requestedTool: providerMessage, options: null }),
  row('permission-requested', { ...requested, options: null }),
  row('permission-requested', { ...requested, options: [{ id: '', label: '' }] }),
  row('permission-requested', { ...requested, reason: '' }),
  row('permission-requested', { ...requested, reason: null }),
  row('permission-requested', resolved),
  row('permission-resolved', { ...resolved, decision: { allow: 'true' } }),
  row('permission-cancelled', { kind: 'cancelled', incarnation: occurrence }),
  row('permission-expired', { kind: 'unknown', incarnation: occurrence }),
]) {
  call('decodeLedgerRow', malformed);
  call('decodeStoredLedgerRow', malformed);
}
call('decodeLedgerRow', row('permission-requested', {
  ...requested, requestedTool: { type: 'tool-result', timestamp: at, toolId: 'synthetic-tool', content: 'result' },
}));
call('decodeLedgerRow', row('permission-resolved', {
  ...resolved, decision: { allow: false, alwaysAllow: 0, response: [] },
}));
call('decodeLedgerRow', row('user-input', {
  ...input, preambleBoundary: { kind: 'new-chat', ownershipEpoch: 'synthetic-epoch' }, preamblePrefixReceipt: receipt,
}, input.clientMessageId));
call('decodeLedgerRow', row('permission-requested', { ...requested, requestId: 'old-native-id', reason: undefined }));
call('decodeLedgerRow', row('provider-row', providerMessage, null, {}));
for (const value of [null, [], 42, ...['constructor', 'toString', '__proto__'].map(type => ({ type }))]) {
  call('decodeLedgerRow', row('provider-row', value));
}
const oldQuestion = {
  type: 'cursor-ask-question-tool-use', timestamp: at, toolId: 'question-call', title: 'Choose',
  questions: [{ id: 'mode', prompt: 'Which mode?', allowMultiple: true, options: [{ id: 'fast', label: 'Fast' }] }],
};
call('decodeLedgerRow', row('provider-row', oldQuestion));
call('decodeLedgerRow', row('permission-requested', { ...requested, requestedTool: oldQuestion }));
call('decodeLedgerRow', row('permission-resolved', {
  ...resolved, decision: { allow: true, response: {
    type: 'ask-user-question-response', outcome: 'answered',
    answers: [{ questionId: 'mode', selectedOptionIds: [], text: 'Custom mode' }],
  } },
}));
call('encodeDecodedLedgerDraft', {
  ...good[2],
  payload_json: '{"providerMeta":{"n":1.0,"big":9007199254740993,"exp21":1e21,"fraction":1e-7},"value":'
    + JSON.stringify(providerMessage) + '}',
});

for (const detail of [
  cli, { ...cli, title: null, presentation: 'info', format: null, disclosure: null },
  { ...cli, title: undefined }, { ...cli, clientMessageId: '' }, { ...cli, title: '' },
  { ...cli, presentation: { ...cli.presentation, extra: true } }, { type: 'notice' }, {},
]) {
  call('parseLedgerCliRowNoticeDetail', detail);
  call('isLedgerCliRowNoticeDetail', detail);
  call('fingerprintDecodedCliRow', 'Synthetic content', detail);
}
for (const detail of [
  selection, { ...selection, clientMessageId: ' trimmed ' }, { ...selection, extra: true },
  { ...selection, clientMessageId: 'x'.repeat(257) },
  { ...selection, requestFingerprint: '' }, { ...selection, selectionRevision: 1.25 },
  { ...selection, preambles: [...selection.preambles, ...selection.preambles] },
  { ...selection, preambles: [{ ...selection.preambles[0], title: ' trim ' }] },
  { ...selection, preambles: [{ ...selection.preambles[0], title: null }] },
  { ...selection, preambles: [{ ...selection.preambles[0], title: 1 }] },
  { ...selection, preambles: [] }, { type: 'notice' }, {},
]) {
  call('parseLedgerPreambleSelectionChangedNoticeDetail', detail);
  call('isLedgerPreambleSelectionChangedNoticeDetail', detail);
}
call('projectLedgerAgentCommandOutcome', {
  type: 'agent-start-outcome', ref: 'sample', async: true, requestViewId: view, requestOrdinal: 1,
  status: 'accepted', chatId: '1000000000000001', nativeResultInput: true, title: 'Private title',
});
call('projectLedgerAgentCommandOutcome', { status: 'accepted' });
call('projectLedgerTicketCommandOutcome', {
  type: 'ticket-command-outcome', command: 'read', ticketId: 'G-1', requestViewId: view,
  requestOrdinal: 1, status: 'ok', revision: 1, nativeResultInput: true, title: 'Private title',
});
call('projectLedgerTicketCommandOutcome', { status: 'ok' });
call('transcriptViewId', view);
call('transcriptViewId', '');
call('fenceDiagnostic', 'SQLiteError', 'SQLITE_CORRUPT', true);
call('fenceDiagnostic', 'SQLiteError', 'SQLITE_CORRUPT', false);
call('fenceDiagnostic', 'not a name', 'not a code', true);
call('fenceDiagnostic', 'A'.repeat(64), 'A'.repeat(65), true);

await Bun.write(new URL('./inputs/codec.jsonl', import.meta.url), calls.map(value => JSON.stringify(value)).join('\n') + '\n');
