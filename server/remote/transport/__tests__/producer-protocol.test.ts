import { expect, test } from 'bun:test';
import { BashToolUseMessage } from '@garcon/common/chat-types';
import { decodeProducerEvent, PRODUCER_BINDING_CODEC_V1 } from '../producer-protocol.js';

const scope = { executorId: 'synthetic-executor', instanceId: 'synthetic-instance', integrationId: 'synthetic-agent' };
const handle = { ...scope, kind: 'execution', id: 'synthetic-execution' };
const requested = {
  type: 'permission', runId: 'synthetic-run',
  lifecycle: {
    kind: 'requested', permissionOccurrenceId: 'synthetic-permission',
    requestedTool: new BashToolUseMessage('2026-01-01T00:00:00Z', 'synthetic-tool', 'true'),
    options: [{ id: 'allow', label: 'Allow' }], reason: 'Synthetic reason',
  },
  decision: { permissionOccurrenceId: 'synthetic-permission', response: { ...scope, kind: 'permission-response', id: 'synthetic-response' } },
};
const creator = PRODUCER_BINDING_CODEC_V1;
const events = [
  { type: 'rows', rows: [{ message: { type: 'assistant-message', timestamp: '2026-01-01T00:00:00Z', content: 'Synthetic output' }, providerMeta: { cursor: 1 } }] },
  { type: 'session', session: { agentSessionId: 'synthetic-session', nativeSession: { ownerId: scope.integrationId, schemaVersion: 1, value: { id: 'synthetic-native' } }, nativeSeedReceipt: null } },
  { type: 'session', session: { agentSessionId: 'synthetic-session', nativeSession: null, nativeSeedReceipt: {
    agentSessionId: 'synthetic-session', placement: 'user-prefix', format: 'v3-xml', codeUnitLength: 12, sha256: 'a'.repeat(64),
  } } },
  requested,
  { type: 'permission', runId: 'synthetic-run', lifecycle: { kind: 'cancelled', permissionOccurrenceId: 'synthetic-permission', reason: null } },
  { type: 'permission', runId: 'synthetic-run', lifecycle: { kind: 'expired', permissionOccurrenceId: 'synthetic-permission' } },
  { type: 'notice', runId: 'synthetic-run', content: 'Synthetic notice', title: 'Synthetic title' },
  { type: 'run-ended', runId: 'synthetic-run', outcome: 'finished', finalResponse: { type: 'literal-text', text: 'Synthetic result' }, workingDirectory: { kind: 'reported', path: '/synthetic' } },
  { type: 'run-ended', runId: 'synthetic-run', outcome: 'failed', error: { code: 'SYNTHETIC_PROVIDER_DETAIL', message: 'Synthetic failure' } },
  { type: 'run-ended', runId: 'synthetic-run', outcome: 'interrupted' },
  { type: 'started', runId: 'synthetic-run' },
  { type: 'steerable', runId: 'synthetic-run' },
  { type: 'publication-failed', error: { code: 'OUTCOME_UNKNOWN' } },
  { type: 'publication-gap' },
  { type: 'launch-settled', runId: 'synthetic-run', handle },
  { type: 'launch-settled', runId: 'synthetic-run', error: { code: 'UNAVAILABLE' } },
];

test('every v1 producer discriminant and outcome survives its wire round trip', () => {
  expect([...new Set(events.map(event => event.type))].sort()).toEqual(Object.keys(creator.codecs).sort());
  for (const event of events) {
    const wire = JSON.parse(JSON.stringify(event));
    expect(JSON.parse(JSON.stringify(decodeProducerEvent(wire, scope, creator)))).toEqual(wire);
  }
});

test.each([
  null, [], 42, { type: 'constructor' }, { type: 'synthetic-unknown' },
  { type: 'rows', rows: null }, { type: 'rows', rows: [null] },
  { type: 'rows', rows: [{ message: { type: 'synthetic-unknown' } }] },
  { type: 'session', session: { agentSessionId: '', nativeSession: null, nativeSeedReceipt: null } },
  { type: 'session', session: { agentSessionId: 'synthetic-session', nativeSession: { ownerId: 'other', schemaVersion: 1, value: {} }, nativeSeedReceipt: null } },
  { type: 'session', session: { agentSessionId: 'synthetic-session', nativeSession: null } },
  { type: 'notice', content: 'Synthetic' }, { type: 'notice', runId: 'synthetic', content: 42 },
  { type: 'started' }, { type: 'steerable', runId: null },
  { type: 'run-ended', runId: 'synthetic', outcome: 'synthetic-unknown' },
  { type: 'run-ended', runId: 'synthetic', outcome: 'finished', finalResponse: { type: 'synthetic-unknown', text: 'Synthetic' } },
  { type: 'run-ended', runId: 'synthetic', outcome: 'finished', error: { code: 'PROVIDER_FAILURE' } },
  { type: 'run-ended', runId: 'synthetic', outcome: 'interrupted', finalResponse: { type: 'text', text: 'Synthetic' } },
  { type: 'run-ended', runId: 'synthetic', outcome: 'failed', error: { code: 42 } },
  { type: 'run-ended', runId: 'synthetic', outcome: 'finished', workingDirectory: { kind: 'synthetic-unknown' } },
  { type: 'publication-failed', error: null },
  { type: 'launch-settled', runId: 'synthetic' },
  { type: 'launch-settled', runId: 'synthetic', handle, error: { code: 'PROVIDER_FAILURE' } },
  { type: 'launch-settled', runId: 'synthetic', handle: { ...handle, instanceId: 'other' } },
  { ...requested, decision: { ...requested.decision, permissionOccurrenceId: 'other' } },
  { ...requested, decision: { ...requested.decision, response: { ...requested.decision.response, instanceId: 'other' } } },
  { ...requested, lifecycle: { ...requested.lifecycle, options: [{ id: 42, label: 'Allow' }] } },
  { ...requested, lifecycle: { kind: 'resolved', permissionOccurrenceId: 'synthetic-permission', decision: { kind: 'allow' } } },
  { ...requested, lifecycle: { kind: 'expired', permissionOccurrenceId: 'synthetic-permission' } },
].map(event => [event]))('rejects unreadable producer event %j', event => {
  expect(() => decodeProducerEvent(event, scope, creator)).toThrow();
});

test('decodes from the captured creator, never a newer catalog or a default codec', () => {
  const notice = { type: 'notice', runId: 'synthetic-run', content: 'original' };
  const altered = { ...creator, codecs: { ...creator.codecs, notice: {
    ...creator.codecs.notice!, version: 2,
    decode: () => ({ type: 'notice' as const, runId: 'synthetic-run', content: 'synthetic-v2' }),
  } } };
  expect(decodeProducerEvent(notice, scope, creator)).toEqual(notice);
  expect(decodeProducerEvent(notice, scope, altered)).toMatchObject({ content: 'synthetic-v2' });
  expect(() => decodeProducerEvent(notice, scope, { ...creator, codecs: {} })).toThrow('absent');
});
