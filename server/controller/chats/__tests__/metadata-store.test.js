import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MetadataIndex } from '../metadata-store.js';

const mockRegistry = {
  listAllChats: () => ({}),
  listChatIds: () => [],
  hasChat: () => false,
  onChatRemoved: mock(() => {}),
};
const mockAgents = {
  getExistingTranscriptPreview: mock(() => null),
};
const mockCarryOver = {
  revision: () => 'carry-v1:0',
  logicalMessageCount: () => 0,
  loadPage: async () => ({ messages: [] }),
};

function previewResult(preview) {
  return { preview };
}

function session(overrides = {}) {
  return {
    agentId: 'codex',
    agentSessionId: 'thread-1',
    agentOwnershipEpoch: 'owner-1',
    carryOverSegments: [],
    carryOverMigrationQuarantine: null,
    ...overrides,
  };
}

let chatCounter = 0;

function makeRegistry(sessions = {}) {
  return {
    listAllChats: mock(() => sessions),
    listChatIds: mock(() => Object.keys(sessions)),
    hasChat: (chatId) => chatId in sessions,
    getChat: (chatId) => sessions[chatId] ?? null,
    onChatRemoved: mock(() => {}),
  };
}

function makeSnapshot(chats) {
  return {
    version: 1,
    chats,
  };
}

describe('metadata-store', () => {
  let metadata;
  let chatId;
  let tmpDir;

  beforeEach(async () => {
    chatCounter += 1;
    chatId = `meta-test-${chatCounter}`;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-metadata-test-'));
    metadata = new MetadataIndex(mockRegistry, mockAgents, mockCarryOver);
    metadata.addNewChatMetadata(chatId, 'initial message');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('extractPreviewText uses full message content', () => {
    it('keeps full multiline content from assistant-message', () => {
      metadata.updateFromAppendedMessages(chatId, [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: 'first line\nsecond line\nthird' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('first line\nsecond line\nthird');
    });

    it('keeps full multiline content from user-message', () => {
      metadata.updateFromAppendedMessages(chatId, [
        { type: 'user-message', timestamp: '2026-01-02T00:00:00Z', content: 'question line\nmore details' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('question line\nmore details');
    });

    it('returns full content when no newline', () => {
      metadata.updateFromAppendedMessages(chatId, [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: 'single line' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('single line');
    });

    it('preserves whitespace', () => {
      metadata.updateFromAppendedMessages(chatId, [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: '  padded content  \nmore' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('  padded content  \nmore');
    });

    it('returns empty string for non-displayable message types', () => {
      const metaBefore = metadata.getChatMetadata(chatId);
      const prevMessage = metaBefore.lastMessage;

      metadata.updateFromAppendedMessages(chatId, [
        { type: 'read-tool-use', timestamp: '2026-01-02T00:00:00Z', toolId: 't1', filePath: '/tmp/test.ts' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe(prevMessage);
    });
  });

  describe('updateFromAppendedMessages', () => {
    it('updates lastActivity from message timestamps', () => {
      metadata.updateFromAppendedMessages(chatId, [
        { type: 'bash-tool-use', timestamp: '2099-01-01T00:00:00Z', toolId: 't1', command: 'ls' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastActivity).toBe('2099-01-01T00:00:00Z');
    });

    it('creates metadata when live messages arrive before startup repair', () => {
      metadata.updateFromAppendedMessages('unknown-chat', [
        { type: 'user-message', timestamp: '2026-01-01T00:00:00Z', content: 'hello' },
      ]);

      const meta = metadata.getChatMetadata('unknown-chat');
      expect(meta.firstMessage).toBe('hello');
      expect(meta.lastMessage).toBe('hello');
      expect(meta.source).toBe('live');
    });

    it('saves live updates to disk', async () => {
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      const index = new MetadataIndex(mockRegistry, mockAgents, mockCarryOver, { metadataPath, saveDelayMs: 0 });
      index.addNewChatMetadata('live-chat', 'first');

      index.updateFromAppendedMessages('live-chat', [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: 'saved preview' },
      ]);
      await index.flush();

      const saved = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      expect(saved.chats['live-chat'].lastMessage).toBe('saved preview');
      expect(saved.chats['live-chat'].source).toBe('live');
      const stats = await fs.stat(metadataPath);
      expect(stats.mode & 0o777).toBe(0o600);
    });

  });

  describe('identity invalidation', () => {
    const identity = (overrides = {}) => ({
      carryOverRevision: 'carry-v1:0',
      agentOwnershipEpoch: 'owner-1',
      ...overrides,
    });

    it('stamps the commit identity on durable append', () => {
      metadata.updateFromAppendedMessages(chatId, [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: 'appended' },
      ], identity());

      expect(metadata.getChatMetadata(chatId).identity).toEqual(identity());
    });

    it('rebuilds preview text from a replacement transcript view', () => {
      metadata.updateFromAppendedMessages(chatId, [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: 'pre-reset tail' },
      ], identity());

      metadata.replaceFromTranscriptView(chatId, [
        { type: 'user-message', timestamp: '2026-01-01T00:00:00Z', content: 'surviving prompt' },
        { type: 'assistant-message', timestamp: '2026-01-01T00:01:00Z', content: 'surviving reply' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('surviving reply');
      expect(meta.lastActivity).toBe('2026-01-01T00:01:00Z');
      expect(meta.identity).toEqual(identity());
    });
  });

  describe('init', () => {
    it('repairs permissions on existing metadata', async () => {
      if (process.platform === 'win32') return;
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify({ version: 1, chats: {} }), { mode: 0o644 });
      const index = new MetadataIndex(mockRegistry, mockAgents, mockCarryOver, { metadataPath });

      await index.init();

      expect((await fs.stat(metadataPath)).mode & 0o777).toBe(0o600);
    });

    it('loads existing metadata when permission repair fails', async () => {
      if (process.platform === 'win32') return;
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(makeSnapshot({
        'persisted-chat': {
          firstMessage: 'first persisted',
          lastMessage: 'last persisted',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-02T00:00:00Z',
          source: 'live',
        },
      })), { mode: 0o644 });
      const chmod = spyOn(fs, 'chmod').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EPERM' }));
      try {
        const index = new MetadataIndex(
          makeRegistry({ 'persisted-chat': session() }),
          mockAgents,
          mockCarryOver,
          { metadataPath },
        );
        await index.init();
        expect(index.getChatMetadata('persisted-chat').lastMessage).toBe('last persisted');
      } finally {
        chmod.mockRestore();
      }
    });

    it('loads persisted metadata before agent preview repair', async () => {
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(makeSnapshot({
        'persisted-chat': {
          firstMessage: 'first persisted',
          lastMessage: 'last persisted',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-02T00:00:00Z',
          source: 'live',
        },
      })), 'utf8');
      const agents = { getExistingTranscriptPreview: mock(() => null) };
      const index = new MetadataIndex(
        makeRegistry({ 'persisted-chat': session() }),
        agents,
        mockCarryOver,
        { metadataPath },
      );

      await index.init();
      await index.flush();

      expect(agents.getExistingTranscriptPreview).toHaveBeenCalledTimes(0);
      expect(index.getChatMetadata('persisted-chat').lastMessage).toBe('last persisted');
    });

    it('repairs missing metadata from existing transcript previews', async () => {
      const agents = {
        getExistingTranscriptPreview: mock(() => previewResult({
          firstMessage: 'first repaired',
          lastMessage: 'last repaired',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-02T00:00:00Z',
        })),
      };
      const index = new MetadataIndex(
        makeRegistry({ 'missing-chat': session() }),
        agents,
        mockCarryOver,
      );

      await index.init();
      expect(agents.getExistingTranscriptPreview).not.toHaveBeenCalled();
      await index.repair();
      expect(agents.getExistingTranscriptPreview).toHaveBeenCalledTimes(1);
      expect(index.getChatMetadata('missing-chat').lastMessage).toBe('last repaired');
      expect(index.getChatMetadata('missing-chat').source).toBe('agent-preview');
    });

    it('yields during synchronous repairs, stops at the elapsed budget, and preserves completed work', async () => {
      const sessions = Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`chat-${i}`, session()]));
      const agents = { getExistingTranscriptPreview: mock(() => {
        const end = performance.now() + 4;
        while (performance.now() < end) { /* Simulates synchronous SQLite/JSON work. */ }
        return previewResult({ firstMessage: 'repaired' });
      }) };
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      const index = new MetadataIndex(makeRegistry(sessions), agents, mockCarryOver, {
        metadataPath, repairDeadlineMs: 20,
      });
      await index.init();
      expect(agents.getExistingTranscriptPreview).not.toHaveBeenCalled();
      let timerFired = false;
      const timer = setTimeout(() => { timerFired = true; }, 1);
      const repair = index.repair();
      expect(index.repair()).toBe(repair);
      await repair;
      clearTimeout(timer);
      expect(timerFired).toBe(true);
      expect(agents.getExistingTranscriptPreview.mock.calls.length).toBeGreaterThan(0);
      expect(agents.getExistingTranscriptPreview.mock.calls.length).toBeLessThan(48);
      await index.flush();
      const saved = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      expect(Object.keys(saved.chats)).toHaveLength(agents.getExistingTranscriptPreview.mock.calls.length);
      expect(saved.chats['chat-0'].firstMessage).toBe('repaired');
    });

    it.each(['append', 'replace', 'delete', 'ownership'])('rechecks %s changes between background reads', async (change) => {
      const sessions = { first: session(), second: session() };
      const firstRead = Promise.withResolvers();
      const transcripts = { getExistingTranscriptPreview: mock((_entry, id) => {
        if (id === 'first') firstRead.resolve();
        return previewResult({ firstMessage: 'repaired' });
      }) };
      const index = new MetadataIndex(makeRegistry(sessions), transcripts, mockCarryOver);
      await index.init();
      const repair = index.repair();
      await firstRead.promise;
      if (change === 'append') index.updateFromAppendedMessages('second', [{ type: 'user-message', content: 'live' }]);
      if (change === 'replace') index.replaceFromTranscriptView('second', [{ type: 'user-message', content: 'replacement' }]);
      if (change === 'delete') delete sessions.second;
      if (change === 'ownership') sessions.second = session({ agentOwnershipEpoch: 'new-owner' });
      await repair;
      if (change === 'append') expect(index.getChatMetadata('second').firstMessage).toBe('live');
      if (change === 'replace') expect(index.getChatMetadata('second').firstMessage).toBe('replacement');
      if (change === 'delete') expect(index.getChatMetadata('second')).toBeNull();
      if (change === 'ownership') {
        expect(index.getChatMetadata('second').identity.agentOwnershipEpoch).toBe('new-owner');
      } else {
        expect(transcripts.getExistingTranscriptPreview).toHaveBeenCalledTimes(1);
      }
    });

    it('stops background reads on close without losing completed repairs', async () => {
      const firstRead = Promise.withResolvers();
      const transcripts = { getExistingTranscriptPreview: mock(() => {
        firstRead.resolve();
        return previewResult({ firstMessage: 'kept' });
      }) };
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      const index = new MetadataIndex(makeRegistry({ first: session(), second: session() }), transcripts, mockCarryOver, { metadataPath });
      await index.init();
      const repair = index.repair();
      await firstRead.promise;
      await index.close();
      await repair;
      await index.repair();
      await index.flush();
      expect(transcripts.getExistingTranscriptPreview).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await fs.readFile(metadataPath, 'utf8')).chats.first.firstMessage).toBe('kept');
    });

    it('isolates a failed preview and continues with healthy chats', async () => {
      const transcripts = { getExistingTranscriptPreview: (_entry, id) => {
        if (id === 'bad') throw new Error('Synthetic ledger failure');
        return previewResult({ firstMessage: 'healthy' });
      } };
      const index = new MetadataIndex(makeRegistry({ bad: session(), good: session() }), transcripts, mockCarryOver);
      await index.init();
      await index.repair();
      expect(index.getChatMetadata('bad')).toBeNull();
      expect(index.getChatMetadata('good').firstMessage).toBe('healthy');
    });

    it('keeps persisted metadata when agent preview repair would stall', async () => {
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(makeSnapshot({
        'stalled-chat': {
          firstMessage: 'persisted first',
          lastMessage: 'persisted last',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-02T00:00:00Z',
          source: 'live',
        },
      })), 'utf8');
      const stalledAgents = {
        getExistingTranscriptPreview: mock(() => { throw new Error('Must not read'); }),
      };
      const index = new MetadataIndex(
        makeRegistry({ 'stalled-chat': session({ agentId: 'opencode', agentSessionId: 'opencode-session' }) }),
        stalledAgents,
        mockCarryOver,
        { metadataPath },
      );

      await index.init();
      await index.repair();
      await index.flush();

      expect(stalledAgents.getExistingTranscriptPreview).toHaveBeenCalledTimes(0);
      expect(index.getChatMetadata('stalled-chat').lastMessage).toBe('persisted last');
    });

    it('repairs an entry after ownership changes', async () => {
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(makeSnapshot({
        'stale-chat': {
          firstMessage: 'old first',
          lastMessage: 'old last',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-02T00:00:00Z',
          source: 'live',
          identity: {
            carryOverRevision: 'carry-v1:0',
            agentOwnershipEpoch: 'owner-1',
          },
        },
      })), 'utf8');
      const agents = {
        getExistingTranscriptPreview: mock(() => previewResult({
          firstMessage: 'fresh first',
          lastMessage: 'fresh last',
          createdAt: '2026-02-01T00:00:00Z',
          lastActivity: '2026-02-02T00:00:00Z',
        })),
      };
      const index = new MetadataIndex(
        makeRegistry({ 'stale-chat': session({ agentOwnershipEpoch: 'owner-2' }) }),
        agents,
        mockCarryOver,
        { metadataPath },
      );

      await index.init();
      await index.repair();
      expect(agents.getExistingTranscriptPreview).toHaveBeenCalledTimes(1);
      expect(index.getChatMetadata('stale-chat').lastMessage).toBe('fresh last');
      expect(index.getChatMetadata('stale-chat').identity).toEqual({
        carryOverRevision: 'carry-v1:0',
        agentOwnershipEpoch: 'owner-2',
      });
    });

    it('keeps a matching identity without reopening the ledger', async () => {
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(makeSnapshot({
        'fresh-chat': {
          firstMessage: 'kept first',
          lastMessage: 'kept last',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-02T00:00:00Z',
          source: 'live',
          identity: {
            carryOverRevision: 'carry-v1:0',
            agentOwnershipEpoch: 'owner-1',
          },
        },
      })), 'utf8');
      const agents = { getExistingTranscriptPreview: mock(() => null) };
      const index = new MetadataIndex(
        makeRegistry({ 'fresh-chat': session() }),
        agents,
        mockCarryOver,
        { metadataPath },
      );

      await index.init();
      await index.repair();
      expect(agents.getExistingTranscriptPreview).not.toHaveBeenCalled();
      expect(index.getChatMetadata('fresh-chat').lastMessage).toBe('kept last');
    });

    it('uses the full ledger preview without rereading legacy carryover', async () => {
      const carryOver = {
        revision: () => 'carry-v5:seg',
        loadPage: mock(() => { throw new Error('Legacy carryover must not be opened'); }),
      };
      const transcripts = { getExistingTranscriptPreview: mock(() => previewResult({
        firstMessage: 'carried first',
        lastMessage: 'current reply',
        createdAt: '2026-01-01T00:00:00Z',
        lastActivity: '2026-01-02T00:00:00Z',
      })) };
      const index = new MetadataIndex(
        makeRegistry({
          'handoff-chat': session({
            carryOverSegments: [{ id: 'seg' }],
          }),
        }),
        transcripts,
        carryOver,
      );

      await index.init();
      await index.repair();

      const meta = index.getChatMetadata('handoff-chat');
      expect(meta.firstMessage).toBe('carried first');
      expect(meta.lastMessage).toBe('current reply');
      expect(meta.createdAt).toBe('2026-01-01T00:00:00Z');
      expect(meta.identity.carryOverRevision).toBe('carry-v5:seg');
      expect(carryOver.loadPage).not.toHaveBeenCalled();
    });

    it('quietly defers missing previews and preserves stale metadata until adoption', async () => {
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(makeSnapshot({
        'stale-chat': {
          firstMessage: 'cached first',
          lastMessage: 'cached last',
          source: 'live',
          identity: { carryOverRevision: 'old', agentOwnershipEpoch: 'old' },
        },
      })));
      const transcripts = { getExistingTranscriptPreview: mock(() => null) };
      const index = new MetadataIndex(
        makeRegistry({ 'stale-chat': session(), 'unadopted-chat': session() }),
        transcripts,
        mockCarryOver,
        { metadataPath },
      );
      const warning = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await index.init();
        await index.repair();
        await index.flush();
        expect(transcripts.getExistingTranscriptPreview).toHaveBeenCalledTimes(2);
        expect(index.getChatMetadata('unadopted-chat')).toBeNull();
        expect(index.getChatMetadata('stale-chat').lastMessage).toBe('cached last');
        expect(warning).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
      }
    });

    it('prunes persisted metadata for removed chats', async () => {
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(makeSnapshot({
        'removed-chat': {
          firstMessage: 'old first',
          lastMessage: 'old last',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-02T00:00:00Z',
          source: 'live',
        },
      })), 'utf8');
      const index = new MetadataIndex(makeRegistry({}), mockAgents, mockCarryOver, { metadataPath });

      await index.init();
      await index.flush();

      const saved = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      expect(index.getChatMetadata('removed-chat')).toBeNull();
      expect(saved.chats['removed-chat']).toBeUndefined();
    });
  });
});
