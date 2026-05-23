import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ChatRegistry } from '../store.js';

let tmpDir;
let registry;

describe('ChatRegistry', () => {
  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    registry = new ChatRegistry(tmpDir);
    await registry.init();
  });

  describe('addChat / getChat', () => {
    it('adds and retrieves a chat entry', () => {
      registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p' });
      const entry = registry.getChat('c1');
      expect(entry).not.toBeNull();
      expect(entry.agentId).toBe('claude');
      expect(entry.model).toBe('opus');
      expect(entry.nextForkOrdinal).toBe(1);
    });

    it('throws on duplicate chat ID', () => {
      registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p' });
      expect(() => registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p' }))
        .toThrow('already exists');
    });

    it('returns null for unknown chat', () => {
      expect(registry.getChat('unknown')).toBeNull();
    });

    it('normalizes invalid mode values on add', () => {
      registry.addChat({
        id: 'c1',
        agentId: 'claude',
        model: 'opus',
        projectPath: '/p',
        permissionMode: 'bogus',
        thinkingMode: 'very-hard',
        claudeThinkingMode: 'sometimes',
      });

      const entry = registry.getChat('c1');
      expect(entry?.permissionMode).toBe('default');
      expect(entry?.thinkingMode).toBe('none');
      expect(entry?.claudeThinkingMode).toBe('auto');
    });

    it('normalizes invalid nextForkOrdinal values on add', () => {
      registry.addChat({
        id: 'c1',
        agentId: 'claude',
        model: 'opus',
        projectPath: '/p',
        nextForkOrdinal: 0,
      });

      const entry = registry.getChat('c1');
      expect(entry?.nextForkOrdinal).toBe(1);
    });

    it('normalizes current agent fields without preserving unknown persisted fields', async () => {
      const filePath = path.join(tmpDir, 'chats.json');
      await fs.writeFile(filePath, JSON.stringify({
        version: 2,
        sessions: {
          c1: {
            agentId: 'claude',
            agentSessionId: 'native-1',
            nativePath: '/tmp/chat.jsonl',
            projectPath: '/p',
            model: 'opus',
            unexpected: 'drop-me',
          },
        },
      }));

      const fresh = new ChatRegistry(tmpDir);
      await fresh.init();

      const entry = fresh.getChat('c1');
      expect(entry?.agentId).toBe('claude');
      expect(entry?.agentSessionId).toBe('native-1');
      expect(entry).not.toHaveProperty('unexpected');

      fresh.updateChat('c1', { model: 'sonnet' });
      await fresh.flush();

      const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
      expect(persisted.sessions.c1.agentId).toBe('claude');
      expect(persisted.sessions.c1.agentSessionId).toBe('native-1');
      expect(persisted.sessions.c1.unexpected).toBeUndefined();
    });

    it('migrates legacy persisted provider fields to current agent fields', async () => {
      const filePath = path.join(tmpDir, 'chats.json');
      await fs.writeFile(filePath, JSON.stringify({
        version: 1,
        sessions: {
          c1: {
            provider: 'claude',
            providerSessionId: 'native-1',
            nativePath: '/tmp/native-1.jsonl',
            projectPath: '/p',
            model: 'opus',
          },
        },
      }));

      const fresh = new ChatRegistry(tmpDir);
      await fresh.init();

      const entry = fresh.getChat('c1');
      expect(entry?.agentId).toBe('claude');
      expect(entry?.agentSessionId).toBe('native-1');

      const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
      expect(persisted.version).toBe(2);
      expect(persisted.sessions.c1.agentId).toBe('claude');
      expect(persisted.sessions.c1.agentSessionId).toBe('native-1');
      expect(persisted.sessions.c1.provider).toBeUndefined();
      expect(persisted.sessions.c1.providerSessionId).toBeUndefined();
    });
  });

  describe('updateChat', () => {
    it('patches allowed fields', () => {
      registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p' });
      registry.updateChat('c1', { model: 'sonnet', nativePath: '/new.jsonl' });
      const entry = registry.getChat('c1');
      expect(entry.model).toBe('sonnet');
      expect(entry.nativePath).toBe('/new.jsonl');
    });

    it('returns null for unknown chat', () => {
      const result = registry.updateChat('unknown', { model: 'opus' });
      expect(result).toBeNull();
    });

    it('normalizes invalid mode patches', () => {
      registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p' });

      registry.updateChat('c1', {
        permissionMode: 'bogus',
        thinkingMode: 'very-hard',
        claudeThinkingMode: 'sometimes',
      });

      const entry = registry.getChat('c1');
      expect(entry?.permissionMode).toBe('default');
      expect(entry?.thinkingMode).toBe('none');
      expect(entry?.claudeThinkingMode).toBe('auto');
    });

    it('patches nextForkOrdinal with positive integers only', () => {
      registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p' });

      registry.updateChat('c1', { nextForkOrdinal: 4 });
      expect(registry.getChat('c1')?.nextForkOrdinal).toBe(4);

      registry.updateChat('c1', { nextForkOrdinal: 0 });
      expect(registry.getChat('c1')?.nextForkOrdinal).toBeUndefined();
    });
  });

  describe('removeChat', () => {
    it('removes a chat and emits chat-removed', () => {
      registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p' });
      const events = [];
      registry.onChatRemoved((id) => events.push(id));

      const removed = registry.removeChat('c1');

      expect(removed).toBe(true);
      expect(registry.getChat('c1')).toBeNull();
      expect(events).toEqual(['c1']);
    });

    it('returns false for unknown chat', () => {
      expect(registry.removeChat('unknown')).toBe(false);
    });
  });

  describe('chat-read-updated event', () => {
    it('emits chat-read-updated on lastReadAt patch', () => {
      registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p' });
      const events = [];
      registry.onChatReadUpdated((id, ts) => events.push({ id, ts }));

      registry.updateChat('c1', { lastReadAt: '2026-01-01T00:00:00Z' });

      expect(events).toEqual([{ id: 'c1', ts: '2026-01-01T00:00:00Z' }]);
    });

    it('does not emit for non-read patches', () => {
      registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p' });
      const events = [];
      registry.onChatReadUpdated((id, ts) => events.push({ id, ts }));

      registry.updateChat('c1', { model: 'sonnet' });

      expect(events).toEqual([]);
    });
  });

  describe('getChatByNativePath', () => {
    it('finds a chat by native path', () => {
      registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p', nativePath: '/tmp/a.jsonl' });
      const result = registry.getChatByNativePath('/tmp/a.jsonl');
      expect(result).not.toBeNull();
      expect(result[0]).toBe('c1');
    });

    it('returns null for unknown path', () => {
      expect(registry.getChatByNativePath('/unknown')).toBeNull();
    });

    it('returns null for null path', () => {
      expect(registry.getChatByNativePath(null)).toBeNull();
    });
  });

  describe('getChatByAgentSessionId', () => {
    it('finds a chat by agent session ID', () => {
      registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p', agentSessionId: 'ps1' });
      const result = registry.getChatByAgentSessionId('ps1');
      expect(result).not.toBeNull();
      expect(result[0]).toBe('c1');
    });

    it('returns null for unknown session ID', () => {
      expect(registry.getChatByAgentSessionId('unknown')).toBeNull();
    });
  });

  describe('listAllChats', () => {
    it('returns a shallow copy of all sessions', () => {
      registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p' });
      registry.addChat({ id: 'c2', agentId: 'codex', model: 'gpt', projectPath: '/q' });
      const all = registry.listAllChats();
      expect(Object.keys(all)).toEqual(['c1', 'c2']);
    });
  });

  describe('init from disk', () => {
    it('loads saved registry on init', async () => {
      registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p' });
      await registry.saveRegistry(registry.getRegistry());

      const fresh = new ChatRegistry(tmpDir);
      await fresh.init();
      expect(fresh.getChat('c1')).not.toBeNull();
      expect(fresh.getChat('c1').agentId).toBe('claude');
    });

    it('returns empty registry for missing file', async () => {
      const emptyDir = path.join(os.tmpdir(), `registry-empty-${Date.now()}`);
      await fs.mkdir(emptyDir, { recursive: true });
      const fresh = new ChatRegistry(emptyDir);
      await fresh.init();
      expect(Object.keys(fresh.listAllChats())).toEqual([]);
    });

    it('normalizes invalid persisted mode values on init', async () => {
      await fs.writeFile(path.join(tmpDir, 'chats.json'), JSON.stringify({
        version: 2,
        sessions: {
          c1: {
            agentId: 'claude',
            nativePath: null,
            projectPath: '/p',
            tags: [],
            agentSessionId: 'ps1',
            model: 'opus',
            permissionMode: 'bogus',
            thinkingMode: 'very-hard',
            claudeThinkingMode: 'sometimes',
          },
        },
      }, null, 2), 'utf8');

      const fresh = new ChatRegistry(tmpDir);
      await fresh.init();

      expect(fresh.getChat('c1')?.permissionMode).toBe('default');
      expect(fresh.getChat('c1')?.thinkingMode).toBe('none');
      expect(fresh.getChat('c1')?.claudeThinkingMode).toBe('auto');
    });

    it('recovers missing agentSessionId from artificial native paths during migration', async () => {
      await fs.writeFile(path.join(tmpDir, 'chats.json'), JSON.stringify({
        version: 1,
        sessions: {
          c1: {
            agentId: 'amp',
            nativePath: '!amp:amp-thread-1',
            projectPath: '/p',
            tags: [],
            model: 'default',
          },
        },
      }, null, 2), 'utf8');

      const fresh = new ChatRegistry(tmpDir);
      await fresh.init();

      expect(fresh.getChat('c1')?.agentSessionId).toBe('amp-thread-1');
      const changed = await fresh.reconcileSessions(async () => '/should-not-be-used');
      expect(changed).toBe(false);
      expect(fresh.getChat('c1')?.nativePath).toBe('!amp:amp-thread-1');
    });

    it('recovers missing agentSessionId from jsonl native paths during migration', async () => {
      const nativePath = path.join(tmpDir, 'native-1.jsonl');
      await fs.writeFile(nativePath, '', 'utf8');
      await fs.writeFile(path.join(tmpDir, 'chats.json'), JSON.stringify({
        version: 1,
        sessions: {
          c1: {
            agentId: 'claude',
            nativePath,
            projectPath: '/p',
            tags: [],
            model: 'opus',
          },
        },
      }, null, 2), 'utf8');

      const fresh = new ChatRegistry(tmpDir);
      await fresh.init();

      expect(fresh.getChat('c1')?.agentSessionId).toBe('native-1');
      const changed = await fresh.reconcileSessions(async () => '/should-not-be-used');
      expect(changed).toBe(false);
      expect(fresh.getChat('c1')?.nativePath).toBe(nativePath);
    });
  });

  describe('reconcileSessions', () => {
    it('discards chats missing agentSessionId', async () => {
      registry.addChat({ id: 'c1', agentId: 'claude', model: 'opus', projectPath: '/p' });

      const changed = await registry.reconcileSessions(async () => '/should-not-be-used.jsonl');

      expect(changed).toBe(true);
      expect(registry.getChat('c1')).toBeNull();
    });

    it('repairs missing nativePath when resolver succeeds', async () => {
      registry.addChat({
        id: 'c1',
        agentId: 'claude',
        model: 'opus',
        projectPath: '/p',
        agentSessionId: 'ps1',
        nativePath: null,
      });

      const changed = await registry.reconcileSessions(async () => '/resolved/path.jsonl');

      expect(changed).toBe(true);
      expect(registry.getChat('c1')?.nativePath).toBe('/resolved/path.jsonl');
    });

    it('discards chats when nativePath reconciliation fails', async () => {
      registry.addChat({
        id: 'c1',
        agentId: 'claude',
        model: 'opus',
        projectPath: '/p',
        agentSessionId: 'ps1',
        nativePath: null,
      });

      const changed = await registry.reconcileSessions(async () => null);

      expect(changed).toBe(true);
      expect(registry.getChat('c1')).toBeNull();
    });

    it('preserves unresolved chats when nativePath reconciliation throws', async () => {
      registry.addChat({
        id: 'c1',
        agentId: 'codex',
        model: 'gpt',
        projectPath: '/p',
        agentSessionId: 'ps1',
        nativePath: null,
      });
      registry.addChat({
        id: 'c2',
        agentId: 'codex',
        model: 'gpt',
        projectPath: '/p',
        agentSessionId: 'ps2',
        nativePath: null,
      });
      const resolver = mock(async () => {
        throw new Error('app-server unavailable');
      });

      const changed = await registry.reconcileSessions(resolver);

      expect(changed).toBe(false);
      expect(registry.getChat('c1')?.agentSessionId).toBe('ps1');
      expect(registry.getChat('c2')?.agentSessionId).toBe('ps2');
      expect(resolver).toHaveBeenCalledTimes(1);
    });

    it('returns false when registry is already consistent', async () => {
      const existingNativePath = path.join(tmpDir, 'existing.jsonl');
      await fs.writeFile(existingNativePath, '', 'utf8');

      registry.addChat({
        id: 'c1',
        agentId: 'claude',
        model: 'opus',
        projectPath: '/p',
        agentSessionId: 'ps1',
        nativePath: existingNativePath,
      });

      const changed = await registry.reconcileSessions(async () => '/resolved/path.jsonl');

      expect(changed).toBe(false);
      expect(registry.getChat('c1')?.nativePath).toBe(existingNativePath);
    });

    it('repairs stale nativePath when the stored file is missing', async () => {
      registry.addChat({
        id: 'c1',
        agentId: 'claude',
        model: 'opus',
        projectPath: '/p',
        agentSessionId: 'ps1',
        nativePath: '/tmp/missing.jsonl',
      });

      const changed = await registry.reconcileSessions(async () => '/resolved/path.jsonl');

      expect(changed).toBe(true);
      expect(registry.getChat('c1')?.nativePath).toBe('/resolved/path.jsonl');
    });

    it('preserves Codex chats with stale nativePath when repair cannot resolve a replacement', async () => {
      registry.addChat({
        id: 'c1',
        agentId: 'codex',
        model: 'gpt',
        projectPath: '/p',
        agentSessionId: 'thread-1',
        nativePath: '/tmp/missing-codex.jsonl',
      });

      const changed = await registry.reconcileSessions(async () => null);

      expect(changed).toBe(false);
      expect(registry.getChat('c1')?.nativePath).toBe('/tmp/missing-codex.jsonl');
    });

    it('keeps Amp pseudo native paths without filesystem checks', async () => {
      registry.addChat({
        id: 'c1',
        agentId: 'amp',
        model: 'default',
        projectPath: '/p',
        agentSessionId: 'amp-thread-1',
        nativePath: '!amp:amp-thread-1',
      });

      const changed = await registry.reconcileSessions(async () => '/should-not-be-used');

      expect(changed).toBe(false);
      expect(registry.getChat('c1')?.nativePath).toBe('!amp:amp-thread-1');
    });
  });
});
