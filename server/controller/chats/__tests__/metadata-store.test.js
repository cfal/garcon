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
  getExistingTranscriptViewId: () => 'view-1',
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

async function* messagePages(messages) {
  for (let offset = 0; offset < messages.length; offset += 2) yield messages.slice(offset, offset + 2);
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
    chats: Object.fromEntries(Object.entries(chats).map(([id, value]) => [id, { transcriptViewId: 'view-1', ...value }])),
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
      metadata.updateFromAppendedMessages(chatId, 'view-1', [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: 'first line\nsecond line\nthird' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('first line\nsecond line\nthird');
    });

    it('keeps full multiline content from user-message', () => {
      metadata.updateFromAppendedMessages(chatId, 'view-1', [
        { type: 'user-message', timestamp: '2026-01-02T00:00:00Z', content: 'question line\nmore details' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('question line\nmore details');
    });

    it('returns full content when no newline', () => {
      metadata.updateFromAppendedMessages(chatId, 'view-1', [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: 'single line' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('single line');
    });

    it('preserves whitespace', () => {
      metadata.updateFromAppendedMessages(chatId, 'view-1', [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: '  padded content  \nmore' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('  padded content  \nmore');
    });

    it('returns empty string for non-displayable message types', () => {
      const metaBefore = metadata.getChatMetadata(chatId);
      const prevMessage = metaBefore.lastMessage;

      metadata.updateFromAppendedMessages(chatId, 'view-1', [
        { type: 'read-tool-use', timestamp: '2026-01-02T00:00:00Z', toolId: 't1', filePath: '/tmp/test.ts' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe(prevMessage);
    });
  });

  describe('updateFromAppendedMessages', () => {
    it('updates lastActivity from message timestamps', () => {
      metadata.updateFromAppendedMessages(chatId, 'view-1', [
        { type: 'bash-tool-use', timestamp: '2099-01-01T00:00:00Z', toolId: 't1', command: 'ls' },
      ]);

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastActivity).toBe('2099-01-01T00:00:00Z');
    });

    it('creates metadata when live messages arrive before startup repair', () => {
      metadata.updateFromAppendedMessages('unknown-chat', 'view-1', [
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

      index.updateFromAppendedMessages('live-chat', 'view-1', [
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

  describe('preview bounds', () => {
    it('folds long pages with a late first user and nonmonotonic timestamps', async () => {
      async function* pages() {
        yield [{ type: 'bash-tool-use', timestamp: '2026-01-01T00:00:00Z' }];
        for (let i = 0; i < 1_000; i++) {
          yield [{ type: 'assistant-message', timestamp: '2026-01-03T00:00:00Z', content: 'earlier preview' }];
        }
        yield [{ type: 'user-message', timestamp: '2026-01-02T00:00:00Z', content: 'first user' }];
        yield [{ type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: 'last preview' }];
      }
      await metadata.replaceFromTranscriptView('uncached', 'view-1', pages());
      expect(metadata.getChatMetadata('uncached')).toMatchObject({
        createdAt: '2026-01-01T00:00:00Z', lastActivity: '2026-01-03T00:00:00Z',
        firstMessage: 'first user', lastMessage: 'last preview',
      });
    });

    it('removes old previews on empty replacement and does not publish a failed fold', async () => {
      metadata.addNewChatMetadata('fallback', 'original title');
      const current = metadata.getChatMetadata('fallback');
      await metadata.replaceFromTranscriptView('fallback', 'view-1', messagePages([]));
      expect(metadata.getChatMetadata('fallback')).toMatchObject({
        createdAt: current.createdAt, lastActivity: current.createdAt,
        firstMessage: '', lastMessage: '',
      });
      const before = metadata.getChatMetadata('fallback');
      async function* failed() {
        yield [{ type: 'user-message', content: 'unpublished' }];
        throw new Error('view replaced');
      }
      await expect(metadata.replaceFromTranscriptView('fallback', 'view-1', failed())).rejects.toThrow('view replaced');
      expect(metadata.getChatMetadata('fallback')).toBe(before);
    });

    const longFirst = `Refactor the controller\n${'first body '.repeat(1_000)}`;
    const longLast = `Done with the refactor\n${'last body '.repeat(1_000)}`;

    it('caps stored previews while keeping their first lines', async () => {
      await metadata.replaceFromTranscriptView(chatId, 'view-1', messagePages([
        { type: 'user-message', timestamp: '2026-01-01T00:00:00Z', content: longFirst },
        { type: 'assistant-message', timestamp: '2026-01-01T00:01:00Z', content: longLast },
      ]));

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.firstMessage).toHaveLength(4097);
      expect(meta.firstMessage.endsWith('\u2026')).toBe(true);
      expect(meta.firstMessage.split('\n')[0]).toBe('Refactor the controller');
      expect(meta.lastMessage).toHaveLength(513);
      expect(meta.lastMessage.split('\n')[0]).toBe('Done with the refactor');
    });

    it('caps live appends and new chats the same way', () => {
      metadata.updateFromAppendedMessages(chatId, 'view-1', [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: longLast },
      ]);
      metadata.addNewChatMetadata('long-first-chat', longFirst);

      expect(metadata.getChatMetadata(chatId).lastMessage).toHaveLength(513);
      expect(metadata.getChatMetadata('long-first-chat').firstMessage).toHaveLength(4097);
      expect(metadata.getChatMetadata('long-first-chat').lastMessage).toHaveLength(513);
    });

    it('does not split a surrogate pair at the cut', () => {
      metadata.updateFromAppendedMessages(chatId, 'view-1', [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: `${'x'.repeat(511)}\u{1F600}tail` },
      ]);

      expect(metadata.getChatMetadata(chatId).lastMessage).toBe(`${'x'.repeat(511)}\u2026`);
    });

    it('shrinks previews persisted before they were capped on the next save', async () => {
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(makeSnapshot({
        'persisted-chat': { firstMessage: longFirst, lastMessage: longLast, createdAt: '2026-01-01T00:00:00Z' },
      })), { mode: 0o600 });
      const index = new MetadataIndex(makeRegistry({ 'persisted-chat': session() }), mockAgents, mockCarryOver, { metadataPath });

      await index.init();
      await index.flush();

      const saved = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      expect(saved.chats['persisted-chat'].firstMessage).toHaveLength(4097);
      expect(saved.chats['persisted-chat'].lastMessage).toHaveLength(513);
    });
  });

  describe('identity invalidation', () => {

    it.each(['unavailable', 'failed'])('retains cold first-message repair through live appends when preview reads are %s', async outcome => {
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(makeSnapshot({
        cold: { firstMessage: '', lastMessage: '', source: 'live' },
      })));
      const transcripts = {
        getExistingTranscriptViewId: () => 'view-1',
        getExistingTranscriptPreview: mock(() => {
          if (outcome === 'failed') throw new Error('Synthetic preview failure');
          return null;
        }),
      };
      const index = new MetadataIndex(makeRegistry({ cold: session() }), transcripts, mockCarryOver, { metadataPath });
      try {
        await index.init();
        for (const type of ['assistant-message', 'user-message']) {
          expect(() => index.updateFromAppendedMessages('cold', 'view-1', [
            { type, timestamp: '2026-01-02T00:00:00Z', content: 'Synthetic later content' },
          ])).not.toThrow();
        }
        expect(index.getChatMetadata('cold')).toBeNull();
        await index.flush();
        expect(JSON.parse(await fs.readFile(metadataPath, 'utf8')).chats.cold.firstMessage).toBe('');
        transcripts.getExistingTranscriptPreview.mockReturnValue(previewResult({
          firstMessage: 'Synthetic first input', lastMessage: 'Synthetic later content',
        }));
        await index.repair();
        expect(index.getChatMetadata('cold')).toMatchObject({
          firstMessage: 'Synthetic first input', lastMessage: 'Synthetic later content',
        });
      } finally {
        await index.close();
        await index.flush();
      }
    });

    it('serves validated list previews from memory and invalidates replacement synchronously', async () => {
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      const ids = Array.from({ length: 1_000 }, (_, index) => `synthetic-${index}`);
      await fs.writeFile(metadataPath, JSON.stringify(makeSnapshot(Object.fromEntries(
        ids.map(id => [id, { firstMessage: 'Synthetic cached preview', source: 'live' }]),
      ))));
      const transcripts = {
        getExistingTranscriptViewId: mock(() => 'view-1'),
        getExistingTranscriptPreview: mock(() => null),
      };
      const index = new MetadataIndex(makeRegistry(Object.fromEntries(ids.map(id => [id, session()]))),
        transcripts, mockCarryOver, { metadataPath });
      try {
        await index.init();
        expect(index.listAllChatMetadata().size).toBe(0);
        expect(transcripts.getExistingTranscriptViewId).not.toHaveBeenCalled();
        await index.repair();
        expect(transcripts.getExistingTranscriptViewId).toHaveBeenCalledTimes(ids.length);
        transcripts.getExistingTranscriptViewId.mockClear();
        for (let repeat = 0; repeat < 3; repeat += 1) expect(index.listAllChatMetadata().size).toBe(ids.length);
        expect(transcripts.getExistingTranscriptViewId).not.toHaveBeenCalled();
        expect(transcripts.getExistingTranscriptPreview).not.toHaveBeenCalled();
        index.invalidateTranscriptView(ids[0]);
        expect(index.getChatMetadata(ids[0])).toBeNull();
        expect(index.listAllChatMetadata().size).toBe(ids.length - 1);
      } finally {
        await index.close();
        await index.flush();
      }
    });

    it('defers unavailable previews instead of certifying them as an empty current view', async () => {
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(makeSnapshot({
        deferred: { firstMessage: 'Synthetic saved preview', source: 'live' },
      })));
      const transcripts = { getExistingTranscriptViewId: () => 'view-2', getExistingTranscriptPreview: mock(() => null) };
      const index = new MetadataIndex(makeRegistry({ deferred: session() }), transcripts, mockCarryOver, { metadataPath });
      try {
        await index.init();
        await index.repair();
        expect(index.getChatMetadata('deferred')).toBeNull();
        await index.flush();
        const persisted = JSON.parse(await fs.readFile(metadataPath, 'utf8')).chats.deferred;
        expect(persisted.transcriptViewId).toBe('view-1');
        expect(persisted.firstMessage).toBe('Synthetic saved preview');
        await index.repair();
        expect(transcripts.getExistingTranscriptPreview).toHaveBeenCalledTimes(2);
      } finally {
        await index.close();
        await index.flush();
      }
    });
    const identity = (overrides = {}) => ({
      carryOverRevision: 'carry-v1:0',
      agentOwnershipEpoch: 'owner-1',
      ...overrides,
    });

    it('stamps the commit identity on durable append', () => {
      metadata.updateFromAppendedMessages(chatId, 'view-1', [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: 'appended' },
      ], identity());

      expect(metadata.getChatMetadata(chatId).identity).toEqual(identity());
    });

    it('rebuilds preview text from a replacement transcript view', async () => {
      metadata.updateFromAppendedMessages(chatId, 'view-1', [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: 'pre-reset tail' },
      ], identity());

      await metadata.replaceFromTranscriptView(chatId, 'view-1', messagePages([
        { type: 'user-message', timestamp: '2026-01-01T00:00:00Z', content: 'surviving prompt' },
        { type: 'assistant-message', timestamp: '2026-01-01T00:01:00Z', content: 'surviving reply' },
        { type: 'bash-tool-use', timestamp: '2026-01-01T00:02:00Z', toolId: 'tool-1', command: 'pwd' },
      ]));

      const meta = metadata.getChatMetadata(chatId);
      expect(meta.lastMessage).toBe('surviving reply');
      expect(meta.lastActivity).toBe('2026-01-01T00:02:00Z');
      expect(meta.identity).toEqual(identity());
    });
  });

  describe('init', () => {
    it('logs metadata that is not JSON by name without echoing it', async () => {
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      await fs.writeFile(metadataPath, '{"chats": SYNTHETIC_SENTINEL}');
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await new MetadataIndex(mockRegistry, mockAgents, mockCarryOver, { metadataPath }).init();
        const output = warn.mock.calls.flat().map(String).join('\n');

        expect(output).toContain('chat-metadata.json is not valid JSON');
        expect(output).not.toContain('SYNTHETIC_SENTINEL');
      } finally {
        warn.mockRestore();
      }
    });

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
        await index.repair();
        expect(index.getChatMetadata('persisted-chat').lastMessage).toBe('last persisted');
      } finally {
        chmod.mockRestore();
      }
    });

    it('withholds persisted metadata until its view is validated by paced repair', async () => {
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
      const agents = { getExistingTranscriptViewId: () => 'view-1',
        getExistingTranscriptPreview: mock(() => null) };
      const index = new MetadataIndex(
        makeRegistry({ 'persisted-chat': session() }),
        agents,
        mockCarryOver,
        { metadataPath },
      );

      await index.init();
      expect(index.getChatMetadata('persisted-chat')).toBeNull();
      expect(index.listAllChatMetadata().size).toBe(0);
      await index.repair();
      await index.flush();

      expect(agents.getExistingTranscriptPreview).toHaveBeenCalledTimes(0);
      expect(index.getChatMetadata('persisted-chat').lastMessage).toBe('last persisted');
    });

    it('repairs missing metadata from existing transcript previews', async () => {
      const agents = {
        getExistingTranscriptViewId: () => 'view-1',
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

    it.each(['missing', 'persisted'])('paces the complete %s repair suffix without a total elapsed-time cutoff', async (kind) => {
      const sessions = Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`chat-${i}`, session()]));
      let elapsed = 0;
      const clock = spyOn(performance, 'now').mockImplementation(() => elapsed);
      const agents = {
        getExistingTranscriptViewId: mock(() => {
          elapsed += 10_000;
          return 'view-1';
        }),
        getExistingTranscriptPreview: mock(() => previewResult({ firstMessage: 'repaired' })),
      };
      const metadataPath = path.join(tmpDir, 'chat-metadata.json');
      if (kind === 'persisted') {
        await fs.writeFile(metadataPath, JSON.stringify(makeSnapshot(Object.fromEntries(
          Object.keys(sessions).map(id => [id, { firstMessage: 'repaired', source: 'live' }]),
        ))));
      }
      const index = new MetadataIndex(makeRegistry(sessions), agents, mockCarryOver, { metadataPath });
      let timerFired = false;
      const timer = setImmediate(() => { timerFired = true; });
      try {
        await index.init();
        expect(index.listAllChatMetadata().size).toBe(0);
        const repair = index.repair();
        expect(index.repair()).toBe(repair);
        await repair;
        expect(index.listAllChatMetadata().size).toBe(48);
        expect(timerFired).toBe(true);
        expect(agents.getExistingTranscriptViewId.mock.calls.map(([id]) => id)).toEqual(Object.keys(sessions));
        expect(agents.getExistingTranscriptPreview).toHaveBeenCalledTimes(kind === 'missing' ? 48 : 0);
        await index.flush();
        const saved = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        expect(Object.keys(saved.chats)).toHaveLength(48);
        expect(saved.chats['chat-47'].firstMessage).toBe('repaired');
      } finally {
        clock.mockRestore();
        clearImmediate(timer);
        await index.close();
        await index.flush();
      }
    });

    it.each(['append', 'replace', 'delete', 'ownership'])('rechecks %s changes between background reads', async (change) => {
      const sessions = { first: session(), second: session() };
      const firstRead = Promise.withResolvers();
      const transcripts = { getExistingTranscriptViewId: () => 'view-1',
        getExistingTranscriptPreview: mock((_entry, id) => {
        if (id === 'first') firstRead.resolve();
        return previewResult({ firstMessage: 'repaired' });
      }) };
      const index = new MetadataIndex(makeRegistry(sessions), transcripts, mockCarryOver);
      await index.init();
      const repair = index.repair();
      await firstRead.promise;
      if (change === 'append') index.updateFromAppendedMessages('second', 'view-1', [{ type: 'user-message', content: 'live' }]);
      if (change === 'replace') await index.replaceFromTranscriptView('second', 'view-1', messagePages([{ type: 'user-message', content: 'replacement' }]));
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
      const transcripts = { getExistingTranscriptViewId: () => 'view-1',
        getExistingTranscriptPreview: mock(() => {
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
      const transcripts = { getExistingTranscriptViewId: () => 'view-1',
        getExistingTranscriptPreview: (_entry, id) => {
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
        getExistingTranscriptViewId: () => 'view-1',
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
        getExistingTranscriptViewId: () => 'view-1',
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
      const agents = { getExistingTranscriptViewId: () => 'view-1',
        getExistingTranscriptPreview: mock(() => null) };
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
      const transcripts = { getExistingTranscriptViewId: () => 'view-1',
        getExistingTranscriptPreview: mock(() => previewResult({
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
      const transcripts = { getExistingTranscriptViewId: () => null,
        getExistingTranscriptPreview: mock(() => null) };
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
        expect(index.getChatMetadata('stale-chat')).toBeNull();
        const persisted = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        expect(persisted.chats['stale-chat'].lastMessage).toBe('cached last');
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
