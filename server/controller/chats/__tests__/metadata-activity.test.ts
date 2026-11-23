import { expect, mock, test } from 'bun:test';
import { UserMessage } from '../../../../common/chat-types.js';
import type { ChatRunOutcome } from '../../../../common/chat-activity.js';
import { LedgerFencedError } from '../../ledger/errors.js';
import { MetadataIndex } from '../metadata-store.js';
import type { ChatRegistryEntry } from '../registry-contracts.js';
import type { IChatRegistry, ChatRemovedCallback } from '../store.js';

const session: ChatRegistryEntry = {
  nativeObservation: null,
  agentId: 'codex', nativeSession: null, agentOwnershipEpoch: 'owner-1',
  agentSettingsById: {}, projectPath: '/synthetic', tags: [], agentSessionId: null,
  model: 'synthetic', permissionMode: 'default', thinkingMode: 'none',
  carryOverSegments: [], nativeSeedReceipt: null, carryOverMigrationQuarantine: null,
  pendingPreambleBoundary: null, preambleSelection: { revision: 0, orderedPreambleIds: [] },
  parentChatId: null, lineage: null,
};

function fixture(options: ConstructorParameters<typeof MetadataIndex>[3] = {}, ids = ['chat']) {
  const views = new Map(ids.map(id => [id, 'view-1']));
  let removed: ChatRemovedCallback = () => {};
  const registry = {
    listChatIds: () => [...views.keys()],
    getChat: (id: string) => views.has(id) ? session : null,
    onChatRemoved: (listener: ChatRemovedCallback) => { removed = listener; },
  } satisfies Pick<IChatRegistry, 'listChatIds' | 'getChat' | 'onChatRemoved'>;
  const transcripts = {
    getExistingTranscriptViewId: mock((id: string) => views.get(id) ?? null),
    getExistingTranscriptPreview: mock((_session: ChatRegistryEntry, _id: string): { preview: unknown } | null => null),
  };
  const index = new MetadataIndex(registry, transcripts, { revision: () => '' }, options);
  return { index, transcripts, views, remove(id: string) { views.delete(id); removed(id, 'user-deletion'); } };
}

test('activity hooks remain optional when current-view reads fail', () => {
  const { index, transcripts } = fixture();
  const failure = index.captureFailureAttempt('chat', 'run-1');
  const terminal = index.captureCommittedOutcome('chat', 'view-1', 'run-1');
  transcripts.getExistingTranscriptViewId.mockImplementation(() => { throw new LedgerFencedError('chat'); });
  expect(() => index.beginRunAttempt('chat', 'run-2')).not.toThrow();
  expect(() => index.clearRunOutcome('chat', 'run-2')).not.toThrow();
  expect(index.captureFailureAttempt('chat', 'run-2')).toBeNull();
  expect(index.captureCommittedOutcome('chat', 'view-1', 'run-2')).toBeNull();
  expect(index.recordFailedAttempt(failure)).toBe(false);
  expect(index.recordCommittedOutcome(terminal, 'finished')).toBe(false);
});

test('repairs a ledger outcome independently of an unavailable text preview', async () => {
  const read = mock(async () => 'failed' as const);
  const { index } = fixture({ readRunOutcome: read });
  await index.init();
  await index.repair();
  expect(index.getChatMetadata('chat')).toBeNull();
  expect(index.getRunOutcome('chat')).toBe('failed');
  expect(read).toHaveBeenCalledWith('chat', 'view-1');
  await index.close();
});

test.each(['unchanged', 'accepted-input', 'replacement', 'deletion', 'closed'] as const)(
  'rechecks prepared recovery at publication after %s', async change => {
    const { index, views, remove } = fixture({ readRunOutcome: async () => 'failed' });
    await index.init();
    try {
      const apply = await index.prepareRunOutcomeRepair('chat');
      if (!apply) throw new Error('Expected prepared outcome repair');
      expect(index.getRunOutcome('chat')).toBeNull();
      if (change === 'accepted-input') index.clearRunOutcome('chat');
      if (change === 'replacement') { views.set('chat', 'view-2'); index.invalidateTranscriptView('chat'); }
      if (change === 'deletion') remove('chat');
      if (change === 'closed') await index.close();
      expect(apply()).toBe(change === 'unchanged');
      expect(index.getRunOutcome('chat')).toBe(change === 'unchanged' ? 'failed' : null);
      expect(apply()).toBe(false);
    } finally {
      await index.close();
    }
  },
);

test.each(['accepted-input', 'started', 'failed', 'terminal'] as const)(
  'skips activity IO after live %s', async change => {
    const read = mock(async () => 'finished' as const);
    const { index } = fixture({ readRunOutcome: read });
    await index.init();
    if (change === 'accepted-input') index.clearRunOutcome('chat');
    if (change === 'started') index.beginRunAttempt('chat', 'run-1');
    if (change === 'failed') index.recordFailedAttempt(index.captureFailureAttempt('chat', 'run-1'));
    if (change === 'terminal') {
      index.recordCommittedOutcome(index.captureCommittedOutcome('chat', 'view-1', 'run-1'), 'finished');
    }
    await index.repair();
    expect(read).not.toHaveBeenCalled();
    await index.close();
  },
);

test('repairs all bounded previews before awaiting a slow outcome scan', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<ChatRunOutcome | null>();
  const { index, transcripts } = fixture({ readRunOutcome: async () => {
    entered.resolve();
    return release.promise;
  } }, ['first', 'second']);
  transcripts.getExistingTranscriptPreview.mockReturnValue({ preview: { firstMessage: 'Synthetic input' } });
  const repair = index.repair();
  try {
    await entered.promise;
    expect(index.getChatMetadata('second')?.firstMessage).toBe('Synthetic input');
  } finally {
    release.resolve('finished');
    await repair;
    await index.close();
  }
});

test.each(['accepted-input', 'replacement', 'deletion', 'closed'] as const)(
  'fences pending recovery after %s without relying on preview identity', async change => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<ChatRunOutcome | null>();
    const { index, views, remove } = fixture({ readRunOutcome: async () => {
      entered.resolve();
      return release.promise;
    } });
    await index.init();
    const repair = index.repair();
    let closed: Promise<void> | undefined;
    try {
      await entered.promise;
      if (change === 'accepted-input') index.clearRunOutcome('chat');
      if (change === 'replacement') { views.set('chat', 'view-2'); index.invalidateTranscriptView('chat'); }
      if (change === 'deletion') remove('chat');
      if (change === 'closed') closed = index.close();
      release.resolve('failed');
      await repair;
      expect(index.getRunOutcome('chat')).toBeNull();
    } finally {
      release.resolve(null);
      await repair;
      await closed;
      await index.close();
    }
  },
);

test.each(['finished', 'failed', 'pre-run-failure'] as const)(
  'delayed input preview fanout preserves the newer %s result', result => {
    const { index } = fixture();
    index.beginRunAttempt('chat', 'run-1');
    index.clearRunOutcome('chat', 'run-1');
    const attempt = result === 'pre-run-failure'
      ? index.captureFailureAttempt('chat', 'run-1')
      : index.captureCommittedOutcome('chat', 'view-1', 'run-1');
    index.updateFromAppendedMessages('chat', 'view-1', [new UserMessage('2026-01-01T00:00:00Z', 'Synthetic input')]);
    if (result === 'pre-run-failure') {
      expect(index.recordFailedAttempt(attempt)).toBe(true);
      expect(index.getRunOutcome('chat')).toBe('failed');
    } else {
      expect(index.recordCommittedOutcome(attempt, result)).toBe(true);
      expect(index.getRunOutcome('chat')).toBe(result);
    }
  },
);
