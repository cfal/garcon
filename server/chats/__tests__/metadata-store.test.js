import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MetadataIndex } from '../metadata-store.js';

const mockRegistry = {
  listAllChats: () => ({}),
  listChatIds: () => [],
  onChatRemoved: mock(() => {}),
};
const mockAgents = {
  getPreview: mock(() => Promise.resolve(null)),
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
      const agents = { getPreview: mock(() => Promise.resolve(null)) };
      const index = new MetadataIndex(
        makeRegistry({ 'persisted-chat': session() }),
        agents,
        mockCarryOver,
        { metadataPath },
      );

      await index.init();
      await index.flush();

      expect(agents.getPreview).toHaveBeenCalledTimes(0);
      expect(index.getChatMetadata('persisted-chat').lastMessage).toBe('last persisted');
    });

    it('repairs missing metadata from agent previews', async () => {
      const agents = {
        getPreview: mock(() => Promise.resolve(previewResult({
          firstMessage: 'first repaired',
          lastMessage: 'last repaired',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-02T00:00:00Z',
        }))),
      };
      const index = new MetadataIndex(
        makeRegistry({ 'missing-chat': session() }),
        agents,
        mockCarryOver,
      );

      await index.init();

      expect(agents.getPreview).toHaveBeenCalledTimes(1);
      expect(index.getChatMetadata('missing-chat').lastMessage).toBe('last repaired');
      expect(index.getChatMetadata('missing-chat').source).toBe('agent-preview');
    });

    it('does not wait indefinitely for a stalled agent preview', async () => {
      const stalledRegistry = makeRegistry({
        'stalled-chat': session({ agentId: 'opencode', agentSessionId: 'opencode-session' }),
      });
      const stalledAgents = {
        getPreview: mock(() => new Promise(() => {})),
      };
      const index = new MetadataIndex(stalledRegistry, stalledAgents, mockCarryOver, { previewTimeoutMs: 5 });

      await index.init();

      expect(stalledAgents.getPreview).toHaveBeenCalledTimes(1);
      expect(index.getChatMetadata('stalled-chat')).toBeNull();
    });

    it('abandons stalled repairs at the overall deadline instead of stretching init', async () => {
      const sessions = {};
      for (let i = 0; i < 8; i += 1) {
        sessions[`stall-${i}`] = session({ agentId: 'opencode', agentSessionId: `opencode-${i}` });
      }
      const stalledAgents = {
        getPreview: mock(() => new Promise(() => {})),
      };
      const index = new MetadataIndex(makeRegistry(sessions), stalledAgents, mockCarryOver, {
        previewTimeoutMs: 200,
        repairDeadlineMs: 30,
      });
      const startedAt = Date.now();

      await index.init();

      // The deadline must beat the first per-preview timeout, proving init
      // returned via the deadline rather than by draining the stalled pool.
      expect(Date.now() - startedAt).toBeLessThan(200);
      expect(index.getChatMetadata('stall-0')).toBeNull();
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
        getPreview: mock(() => new Promise(() => {})),
      };
      const index = new MetadataIndex(
        makeRegistry({ 'stalled-chat': session({ agentId: 'opencode', agentSessionId: 'opencode-session' }) }),
        stalledAgents,
        mockCarryOver,
        { metadataPath, previewTimeoutMs: 5 },
      );

      await index.init();
      await index.flush();

      expect(stalledAgents.getPreview).toHaveBeenCalledTimes(0);
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
        getPreview: mock(() => Promise.resolve(previewResult({
          firstMessage: 'fresh first',
          lastMessage: 'fresh last',
          createdAt: '2026-02-01T00:00:00Z',
          lastActivity: '2026-02-02T00:00:00Z',
        }))),
      };
      const index = new MetadataIndex(
        makeRegistry({ 'stale-chat': session({ agentOwnershipEpoch: 'owner-2' }) }),
        agents,
        mockCarryOver,
        { metadataPath },
      );

      await index.init();

      expect(agents.getPreview).toHaveBeenCalledTimes(1);
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
      const agents = { getPreview: mock(() => Promise.resolve(null)) };
      const index = new MetadataIndex(
        makeRegistry({ 'fresh-chat': session() }),
        agents,
        mockCarryOver,
        { metadataPath },
      );

      await index.init();

      expect(agents.getPreview).not.toHaveBeenCalled();
      expect(index.getChatMetadata('fresh-chat').lastMessage).toBe('kept last');
    });

    it('composes carryover with the segment preview for a post-handoff chat', async () => {
      const carryOver = {
        revision: () => 'carry-v5:seg',
        logicalMessageCount: () => 3,
        loadPage: mock(async ({ offset }) => ({
          messages: offset === 0
            ? [
                { type: 'user-message', timestamp: '2026-01-01T00:00:00Z', content: 'carried first' },
                { type: 'assistant-message', timestamp: '2026-01-01T00:01:00Z', content: 'carried reply' },
              ]
            : [{ type: 'assistant-message', timestamp: '2026-01-01T00:02:00Z', content: 'carried tail' }],
        })),
      };
      const agents = { getPreview: mock(() => Promise.resolve(previewResult(null))) };
      const index = new MetadataIndex(
        makeRegistry({
          'handoff-chat': session({
            carryOverSegments: [{ id: 'seg' }],
          }),
        }),
        agents,
        carryOver,
      );

      await index.init();

      const meta = index.getChatMetadata('handoff-chat');
      expect(meta.firstMessage).toBe('carried first');
      expect(meta.lastMessage).toBe('carried tail');
      expect(meta.createdAt).toBe('2026-01-01T00:00:00Z');
      expect(meta.identity.carryOverRevision).toBe('carry-v5:seg');
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
