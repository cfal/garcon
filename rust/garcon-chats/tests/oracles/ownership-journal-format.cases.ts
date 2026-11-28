import { expect, test } from 'bun:test';
import { createPreambleBoundaryBinding, emptyOwnershipJournalV5, isEmptyEarlierJournal, isJournalV5 } from './ownership-journal-format.ts';

const createdAt = '2026-01-01T00:00:00.000Z';
const settings = (ownerId: string) => ({ ownerId, schemaVersion: 1, values: {} });
const handoff = {
  version: 5, operationId: 'handoff:fixture', clientRequestId: 'fixture', submittedTargetHash: 'a'.repeat(64),
  kind: 'handoff', chatId: '1783725900000200', phase: 'commit-decided',
  source: { agentId: 'codex', agentOwnershipEpoch: 'source' },
  target: { execution: { executorId: null, projectPath: '/fixture', agentId: 'claude', model: '',
    apiProviderId: null, modelEndpointId: null, modelProtocol: null,
    permissionMode: 'default', thinkingMode: 'none', agentSettings: settings('claude'),
  }, agentOwnershipEpoch: 'target' }, watermark: { viewId: 'view', ordinal: 7 }, createdAt,
};
const reference = {
  chatId: handoff.chatId, executorId: '3502b645-222b-49d2-ac39-1c91f9fb1174', agentId: 'codex',
  agentSessionId: null, nativeSession: { ownerId: 'codex', schemaVersion: 1, value: {} },
  projectPath: '/fixture', model: 'model', carryOverRevision: 'carry-v1:0', settings: settings('codex'),
};
const deleted = { version: 2, operationId: 'delete:fixture', kind: 'delete', chatId: handoff.chatId,
  phase: 'registry-removed', sourceEpoch: null, releaseReferences: [reference], createdAt };

test('only an earlier empty journal can be adopted', () => {
  expect(emptyOwnershipJournalV5()).toEqual({ version: 5, ownershipIntents: [] });
  for (const accepted of [{ version: 3, ownershipIntents: [] }, { version: 4, ownershipIntents: [], transferCleanup: [] }]) {
    expect(isEmptyEarlierJournal(accepted)).toBe(true);
  }
  for (const rejected of [null, [], { version: '3', ownershipIntents: [] },
    { version: 5, ownershipIntents: [] }, { version: 3, ownershipIntents: [handoff] },
    { version: 3, ownershipIntents: [], transferCleanup: null }]) {
    expect(isEmptyEarlierJournal(rejected)).toBe(false);
  }
});

test('validates handoff targets, references, and watermarks before accepting the journal', () => {
  const check = (intent: unknown) => isJournalV5({ version: 5, ownershipIntents: [intent] });
  expect(isJournalV5({ version: 5, ownershipIntents: [handoff, deleted] })).toBe(true);
  expect(isJournalV5(null)).toBe(false);
  for (const rejected of [
    { ...handoff, phase: 'prepared' }, { ...handoff, submittedTargetHash: 'x'.repeat(64) },
    { ...handoff, submittedTargetHash: `${handoff.submittedTargetHash}\n` },
    { ...handoff, watermark: { viewId: '', ordinal: -1 } },
    { ...handoff, watermark: { viewId: 'view', ordinal: 2 ** 53 } },
    { ...handoff, source: { ...handoff.source, executorId: 'invalid' } },
    { ...handoff, target: { ...handoff.target, execution: { ...handoff.target.execution, agentSettings: settings('other') } } },
    { ...deleted, sourceEpoch: undefined },
    { ...deleted, releaseReferences: [{ ...reference, agentSessionId: undefined }] },
    { ...deleted, releaseReferences: [{ ...reference, nativeSession: { ...reference.nativeSession, ownerId: 'other' } }] },
  ]) expect(check(rejected)).toBe(false);
  expect(check({ ...deleted, releaseReferences: [{ ...reference, nativeSeedReceipt: 'unchecked detail' }] })).toBe(true);
  expect(check({ ...handoff, phase: 'registry-committed', watermark: { viewId: 'view', ordinal: -0 } })).toBe(true);
});

test('binds the supplied ownership epoch to each lifecycle boundary', () => {
  for (const kind of ['new-chat', 'fork', 'continuation', 'agent-switch'] as const) {
    expect(createPreambleBoundaryBinding(kind, 'fixture')).toEqual({ agentOwnershipEpoch: 'fixture',
      pendingPreambleBoundary: { kind, ownershipEpoch: 'fixture' } });
  }
});
