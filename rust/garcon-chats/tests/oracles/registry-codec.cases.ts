import { expect, test } from 'bun:test';
import { allocateIds, CHAT_ID, commitBoundary, decodeEntry, OTHER_ID, parseSegments, validSegmentId } from './registry-codec.ts';

const raw = () => ({ agentId: 'codex', agentOwnershipEpoch: 'epoch-a',
  agentSettingsById: { codex: { ownerId: 'codex', schemaVersion: 1, values: { example: 1.0 } } },
  model: 'example', projectPath: '/workspace/project', tags: ['review', 1, 'review'],
  nativeSession: { ownerId: 'codex', schemaVersion: 1, value: { data: 'opaque' } },
  agentSessionId: 'session-a', carryOverSegments: [], nativeSeedReceipt: null, carryOverMigrationQuarantine: null,
  parentChatId: null, lineage: null,
});
const segment = { id: '9df00801-0000-1000-9000-000000000009', agentId: 'codex', model: 'example',
  capturedAt: '2026-01-01T00:00:00.000Z', storedMessageCount: 2, visibleMessageCount: 1, trailingHandoff: null };

test('reads present and absent v6 fields in validation order', () => {
  expect(decodeEntry(raw()).tags).toEqual(['review', 'review']);
  expect(decodeEntry({ ...raw(), executorId: null }).executorId).toBeNull();
  expect(decodeEntry({ ...raw(), parentChatId: OTHER_ID }).parentChatId).toBe(OTHER_ID);
  expect(decodeEntry({ ...raw(), lineage: { kind: 'fork', sourceChatId: OTHER_ID, transcriptViewId: 'view', ordinal: 9 } }).lineage?.ordinal).toBe(9);
  expect(() => decodeEntry({ ...raw(), parentChatId: CHAT_ID })).toThrow('cannot be its own parent');
  expect(() => decodeEntry({ ...raw(), parentChatId: undefined })).toThrow('Chat ID must');
  expect(() => decodeEntry({ ...raw(), lineage: undefined })).toThrow('Invalid lineage');
  expect(() => decodeEntry({ ...raw(), parentChat: null, executorId: 'invalid' })).toThrow('Legacy parentChat');
  expect(() => decodeEntry({ ...raw(), executorId: 'invalid', agentSettingsById: null })).toThrow('Invalid executor ID');
  expect(() => decodeEntry({ ...raw(), nativeSession: { ownerId: 'different' }, agentSettingsById: null })).toThrow('Native session owner mismatch');
  expect(() => decodeEntry({ ...raw(), nativeSeedReceipt: undefined })).toThrow('Invalid native seed receipt');
  expect(() => decodeEntry({ ...raw(), preambleSelection: null })).toThrow('Invalid preamble selection');
  expect(() => decodeEntry({ ...raw(), pendingPreambleBoundary: { kind: 'new-chat', ownershipEpoch: 'other' } })).toThrow('ownership epoch mismatch');
  expect(() => decodeEntry({ ...raw(), pendingPreambleBoundary: { kind: 'selection-change', ownershipEpoch: 'epoch-a', selectionRevision: 1 } })).toThrow('selection revision mismatch');
  expect(() => decodeEntry({ ...raw(), carryOverMigrationQuarantine: {} })).toThrow('Invalid carryover migration quarantine');
  expect(decodeEntry({ ...raw(), carryOverSegments: [segment] }).carryOverSegments).toHaveLength(1);
});

test('segment references preserve order and fail closed on invalid cutoffs', () => {
  expect(validSegmentId(segment.id)).toBe(true);
  expect(validSegmentId(segment.id.toUpperCase())).toBe(false);
  expect(validSegmentId(null)).toBe(false);
  expect(parseSegments([segment])).toEqual([segment]);
  expect(() => parseSegments(null)).toThrow('Invalid carryover segment references');
  expect(() => parseSegments([segment, segment])).toThrow('Duplicate carryover segment ID');
  expect(() => parseSegments([{ ...segment, visibleMessageCount: 3 }])).toThrow('outside its artifact');
  expect(() => parseSegments([{ ...segment, visibleMessageCount: 0 }])).toThrow('must expose at least one message');
  expect(() => parseSegments([{ ...segment, storedMessageCount: 0, visibleMessageCount: 0 }])).toThrow('must contain one handoff boundary');
  expect(parseSegments([{ ...segment, storedMessageCount: 0, visibleMessageCount: 0, trailingHandoff: { agentId: 'claude', model: 'other' } }])).toHaveLength(1);
});

test('allocator skips occupied IDs and remains monotonic after the clock rolls back', () => {
  expect(allocateIds([1783725900000, 1783725900000, 1783725899999], ['1783725900000001'])).toEqual([
    '1783725900000000', '1783725900000002', '1783725900000003',
  ]);
});

test.each(['add', 'live', 'phased'] as const)('%s stores a normalized boundary before binding', async (mode) => {
  const boundary = { kind: 'selection-change', ownershipEpoch: 'epoch-a', selectionRevision: 0 };
  expect(await commitBoundary(mode, 'epoch-a', ' \tepoch-a\n')).toEqual({ live: boundary, reopened: boundary });
  expect(await commitBoundary(mode, ' \tepoch-a\n', ' \tepoch-a\n')).toEqual({
    mutationError: 'Preamble boundary ownership epoch mismatch', unchanged: true,
  });
});
