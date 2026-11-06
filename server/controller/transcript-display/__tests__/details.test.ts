import { afterEach, expect, test } from 'bun:test';
import { AskUserQuestionToolUseMessage, BashToolUseMessage, CommandOutputMessage, CommandResultMessage,
  PermissionCancelledMessage, PermissionRequestMessage, PermissionResolvedMessage, ToolResultMessage, TranscriptNoticeMessage,
  type ChatMessage } from '../../../../common/chat-types.js';
import type { BodyDependencyRequest, DisplayProfile, DisplayWindowRequest } from '../../../../common/transcript-display-contract.js';
import { diagnosticDigest } from '../../../../web/src/lib/chat/transcript/local-notice.js';
import { encodeLedgerDraft, type StoredLedgerRow } from '../../ledger/codec.js';
import type { LedgerRowDraft } from '../../ledger/contracts.js';
import { chatIdRequestNoticeDraft } from '../../ledger/garcon-command-request.js';
import { planBodyRead } from '../details.js';
import { appendDisplayFrame } from '../extractor.js';
import { DisplayQuery, displayCertificate } from '../query.js';
import { DisplayStore } from '../store.js';

const at = '2026-01-01T00:00:00.000Z';
const profile: DisplayProfile = { combine: true, showThinking: true, hiddenToolGroups: [], bashRevision: 'patterns' };
const stores: DisplayStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function create() {
  const store = new DisplayStore(':memory:');
  store.initialize('chat', 'view', 'server');
  stores.push(store);
  return store;
}
function stored(draft: LedgerRowDraft, ordinal: number): StoredLedgerRow {
  return { view_id: 'view', ordinal, kind: draft.kind, at, client_message_id: null, payload_json: encodeLedgerDraft(draft).payloadJson };
}
function providerRows(messages: readonly ChatMessage[]) {
  return messages.map((message, index) => stored({ kind: 'provider-row', at, message }, index + 1));
}
function request(watermark: number, seedOrdinals: number[]): BodyDependencyRequest {
  return { certificate: displayCertificate('server', { chatId: 'chat', transcriptViewId: 'view', profile, cuts: [] }, watermark),
    profile, cuts: [], seedOrdinals, residentOrdinals: [], limitBodies: 200, estimatedByteBudget: 10000 };
}

const output = new CommandOutputMessage(at, 'command', 'stdout', 'markdown', '# Generic output', null);
const stderr = new CommandOutputMessage(at, 'command', 'stderr', 'plain', 'Generic diagnostic', null);
const complete = new CommandResultMessage(at, 'command', { outcome: 'finished', exitCode: 0, signal: null,
  capture: 'complete', cwd: { kind: 'reported', path: '/generic' } });
const gap = new TranscriptNoticeMessage(at, 'Generic missing output', { type: 'publication-gap' });

test.each([
  { name: 'complete capture', messages: [output, complete], seed: 1, formats: ['plain', 'markdown'] },
  { name: 'duplicate stdout reverses Markdown', messages: [output, complete, output], seed: 1, formats: ['plain', 'markdown', 'plain'] },
  { name: 'duplicate result reverses Markdown', messages: [output, complete, complete], seed: 1, formats: ['plain', 'markdown', 'plain'] },
  { name: 'incomplete capture', messages: [output, new CommandResultMessage(at, 'command', { ...complete.result, capture: 'incomplete' })], seed: 1, formats: ['plain', 'plain'] },
  { name: 'truncated capture', messages: [output, new CommandResultMessage(at, 'command', { ...complete.result, capture: 'truncated' })], seed: 1, formats: ['plain', 'plain'] },
  { name: 'gap before result', messages: [output, gap, complete], seed: 1, formats: ['plain', 'plain', 'plain'] },
  { name: 'gap before first output', messages: [gap, output, complete], seed: 2, formats: ['plain', 'markdown'] },
  { name: 'gap after result', messages: [output, complete, gap], seed: 1, formats: ['plain', 'markdown', 'markdown'] },
  { name: 'stderr-first gap', messages: [stderr, gap, output, complete], seed: 3, formats: ['plain', 'plain'] },
  { name: 'separate stderr', messages: [output, stderr, complete], seed: 1, formats: ['plain', 'plain', 'markdown'] },
  { name: 'plain stays plain', messages: [new CommandOutputMessage(at, 'command', 'stdout', 'plain', 'Generic output', null), complete], seed: 1, formats: ['plain', 'plain'] },
  { name: 'nonzero offset', messages: [new CommandOutputMessage(at, 'command', 'stdout', 'markdown', 'Generic suffix', null, 10), complete], seed: 1, formats: ['plain', 'plain'] },
  { name: 'result precedes output', messages: [complete, output], seed: 2, formats: ['plain'] },
  { name: 'failed command with complete capture', messages: [output, new CommandResultMessage(at, 'command', { ...complete.result, outcome: 'failed', exitCode: 7 })], seed: 1, formats: ['plain', 'markdown'] },
  { name: 'unrelated command result', messages: [output, new CommandResultMessage(at, 'other-command', complete.result)], seed: 1, formats: ['plain', 'plain'] },
])('qualifies SQL command format at each watermark: $name', ({ messages, seed, formats }) => {
  const store = create(), rows = providerRows(messages);
  for (const row of rows) appendDisplayFrame(store, [row], rows.length, 'server');
  expect(formats.map((_, index) => planBodyRead(store, request(seed + index, [seed])).details[0].commandFormat)).toEqual(formats);
});

test('uses the latest terminal of the selected permission occurrence at or before the watermark', () => {
  const store = create(), question = new AskUserQuestionToolUseMessage(at, 'question', 'Generic question', []);
  const rows = providerRows([question, new PermissionRequestMessage(at, 'occurrence', question),
    new ToolResultMessage(at, 'question', 'Generic answer'), new PermissionResolvedMessage(at, 'occurrence', true),
    new PermissionCancelledMessage(at, 'occurrence', 'aborted'), new PermissionResolvedMessage(at, 'other-occurrence', false)]);
  for (const row of rows) appendDisplayFrame(store, [row], rows.length, 'server');
  for (const [watermark, terminal] of [[3, null], [4, 4], [5, 5], [6, 5]] as const) {
    const plan = planBodyRead(store, request(watermark, [1, 2]));
    expect(plan.details).toEqual([
      { ordinal: 1, pairedUse: 1, pairedResult: 3, questionWrapper: 2, permissionTerminal: terminal, commandFormat: null },
      { ordinal: 2, pairedUse: null, pairedResult: null, questionWrapper: null, permissionTerminal: terminal, commandFormat: null },
    ]);
    expect(plan.ordinals).toEqual(terminal === null ? [1, 3, 2] : [1, 3, 2, terminal]);
  }
});

test('bounds dependency bodies by count and bytes while resident hints preserve detail evidence', () => {
  const store = create(), rows = providerRows([1, 2, 3].flatMap(index => [
    new BashToolUseMessage(at, `tool-${index}`, 'true'), new ToolResultMessage(at, `tool-${index}`, 'Generic result'),
  ]));
  appendDisplayFrame(store, rows, rows.length, 'server');
  const input = { ...request(6, [1, 3, 5, 1]), limitBodies: 2 };
  const first = planBodyRead(store, input);
  expect(first.ordinals).toEqual([1, 2]);
  expect(first.deferredOrdinals).toEqual([3, 4, 5, 6]);
  expect(first.oversizedOrdinal).toBeNull();
  expect(first.details.map(detail => [detail.ordinal, detail.pairedResult])).toEqual([[1, 2], [3, 4], [5, 6]]);
  const second = planBodyRead(store, { ...input, residentOrdinals: [1, 2] });
  expect(second.ordinals).toEqual([3, 4]);
  expect(second.deferredOrdinals).toEqual([5, 6]);
  expect(second.details).toEqual(first.details);
  const last = planBodyRead(store, { ...input, residentOrdinals: [1, 2, 3, 4] });
  expect(last.ordinals).toEqual([5, 6]);
  expect(last.deferredOrdinals).toEqual([]);
  const resident = planBodyRead(store, { ...input, residentOrdinals: [1, 2, 3, 4, 5, 6] });
  expect(resident.ordinals).toEqual([]);
  expect(resident.details).toEqual(first.details);
  const bytes = planBodyRead(store, { ...input, limitBodies: 200, estimatedByteBudget: rows[0].payload_json.length * 2 });
  expect(bytes.ordinals).toEqual([1]);
  expect(bytes.deferredOrdinals).toEqual([2, 3, 4, 5, 6]);
  expect(bytes.oversizedOrdinal).toBeNull();
  const oversized = planBodyRead(store, { ...input, estimatedByteBudget: 1 });
  expect(oversized.ordinals).toEqual([1]);
  expect(oversized.deferredOrdinals).toEqual([2, 3, 4, 5, 6]);
  expect(oversized.oversizedOrdinal).toBe(1);
});

test('carries exact diagnostic digests across frame and private-row boundaries', async () => {
  const store = create();
  const failure = new CommandResultMessage(at, 'command', { ...complete.result, outcome: 'failed', exitCode: 7 });
  const notice = new TranscriptNoticeMessage(at, 'Generic diagnostic \ud800');
  const rows = [stored({ kind: 'provider-row', at, message: failure }, 1), stored(chatIdRequestNoticeDraft(at), 2),
    stored({ kind: 'provider-row', at, message: notice }, 3)];
  appendDisplayFrame(store, rows.slice(0, 1), 3, 'server');
  expect(() => appendDisplayFrame(store, rows.slice(1), 3, 'server')).toThrow('Missing public tail dependency');
  expect(store.manifest()?.prepared_through).toBe(1);
  appendDisplayFrame(store, rows.slice(1), 3, 'server', rows[0]);
  const input: DisplayWindowRequest = { chatId: 'chat', transcriptViewId: 'view', policyRevision: 1,
    profile, cuts: [], anchor: { kind: 'newest' }, limit: 50 };
  const tail = (watermark: number) => new DisplayQuery(store, profile, watermark, [], false)
    .window(input, displayCertificate('server', input, watermark), 3, 3).publicTail;
  expect(tail(1)).toEqual({ ordinal: 1, contentDigest: await diagnosticDigest('Exit 7'), combinedDigest: null });
  expect(tail(2)).toEqual(tail(1));
  expect(tail(3)).toEqual({ ordinal: 3, contentDigest: await diagnosticDigest(notice.content),
    combinedDigest: await diagnosticDigest(`Exit 7\n${notice.content}`) });
  expect(planBodyRead(store, request(3, [2]))).toEqual({ details: [], ordinals: [], deferredOrdinals: [], nonRenderedOrdinals: [2], oversizedOrdinal: null });
});
