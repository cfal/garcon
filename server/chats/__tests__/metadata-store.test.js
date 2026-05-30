import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MetadataIndex } from '../metadata-store.js';

const mockRegistry = {
  listAllChats: () => ({}),
  onChatRemoved: mock(() => {}),
};
const mockAgents = {
  getPreview: mock(() => Promise.resolve(null)),
};

let chatCounter = 0;

function makeRegistry(sessions = {}) {
  return {
    listAllChats: mock(() => sessions),
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
    metadata = new MetadataIndex(mockRegistry, mockAgents);
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
      const index = new MetadataIndex(mockRegistry, mockAgents, { metadataPath, saveDelayMs: 0 });
      index.addNewChatMetadata('live-chat', 'first');

      index.updateFromAppendedMessages('live-chat', [
        { type: 'assistant-message', timestamp: '2026-01-02T00:00:00Z', content: 'saved preview' },
      ]);
      await index.flush();

      const saved = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      expect(saved.chats['live-chat'].lastMessage).toBe('saved preview');
      expect(saved.chats['live-chat'].source).toBe('live');
    });
  });

  describe('init', () => {
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
        makeRegistry({ 'persisted-chat': { agentId: 'codex', agentSessionId: 'thread-1' } }),
        agents,
        { metadataPath },
      );

      await index.init();
      await index.flush();

      expect(agents.getPreview).toHaveBeenCalledTimes(0);
      expect(index.getChatMetadata('persisted-chat').lastMessage).toBe('last persisted');
    });

    it('repairs missing metadata from agent previews', async () => {
      const agents = {
        getPreview: mock(() => Promise.resolve({
          firstMessage: 'first repaired',
          lastMessage: 'last repaired',
          createdAt: '2026-01-01T00:00:00Z',
          lastActivity: '2026-01-02T00:00:00Z',
        })),
      };
      const index = new MetadataIndex(
        makeRegistry({ 'missing-chat': { agentId: 'codex', agentSessionId: 'thread-1' } }),
        agents,
      );

      await index.init();

      expect(agents.getPreview).toHaveBeenCalledTimes(1);
      expect(index.getChatMetadata('missing-chat').lastMessage).toBe('last repaired');
      expect(index.getChatMetadata('missing-chat').source).toBe('agent-preview');
    });

    it('does not wait indefinitely for a stalled agent preview', async () => {
      const stalledRegistry = makeRegistry({
        'stalled-chat': { agentId: 'opencode', agentSessionId: 'opencode-session' },
      });
      const stalledAgents = {
        getPreview: mock(() => new Promise(() => {})),
      };
      const index = new MetadataIndex(stalledRegistry, stalledAgents, { previewTimeoutMs: 5 });

      await index.init();

      expect(stalledAgents.getPreview).toHaveBeenCalledTimes(1);
      expect(index.getChatMetadata('stalled-chat')).toBeNull();
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
        makeRegistry({ 'stalled-chat': { agentId: 'opencode', agentSessionId: 'opencode-session' } }),
        stalledAgents,
        { metadataPath, previewTimeoutMs: 5 },
      );

      await index.init();
      await index.flush();

      expect(stalledAgents.getPreview).toHaveBeenCalledTimes(0);
      expect(index.getChatMetadata('stalled-chat').lastMessage).toBe('persisted last');
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
      const index = new MetadataIndex(makeRegistry({}), mockAgents, { metadataPath });

      await index.init();
      await index.flush();

      const saved = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      expect(index.getChatMetadata('removed-chat')).toBeNull();
      expect(saved.chats['removed-chat']).toBeUndefined();
    });
  });
});
