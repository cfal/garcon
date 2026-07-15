import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ChatRegistry } from '../store.js';

let tmpDir;
let registry;
const CHAT_ID = '1783725900000200';
const CHAT_ID_2 = '1783725900000201';
const ACP_CHAT_ID = '1783725900000202';
const STREAM_JSON_CHAT_ID = '1783725900000203';

describe('ChatRegistry', () => {
  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    registry = new ChatRegistry(tmpDir);
    await registry.init();
  });

  describe('addChat / getChat', () => {
    it('adds and retrieves a chat entry', () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' });
      const entry = registry.getChat(CHAT_ID);
      expect(entry).not.toBeNull();
      expect(entry.agentId).toBe('claude');
      expect(entry.model).toBe('opus');
      expect(entry.nextForkOrdinal).toBe(1);
    });

    it('throws on duplicate chat ID', () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' });
      expect(() => registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' }))
        .toThrow('already exists');
    });

    it('returns null for unknown chat', () => {
      expect(registry.getChat('unknown')).toBeNull();
    });

    it('normalizes invalid mode values on add', () => {
      registry.addChat({
        id: CHAT_ID,
        agentId: 'claude',
        model: 'opus',
        projectPath: '/p',
        permissionMode: 'bogus',
        thinkingMode: 'very-hard',
        claudeThinkingMode: 'sometimes',
      });

      const entry = registry.getChat(CHAT_ID);
      expect(entry?.permissionMode).toBe('default');
      expect(entry?.thinkingMode).toBe('none');
      expect(entry?.claudeThinkingMode).toBe('auto');
    });

    it('normalizes invalid nextForkOrdinal values on add', () => {
      registry.addChat({
        id: CHAT_ID,
        agentId: 'claude',
        model: 'opus',
        projectPath: '/p',
        nextForkOrdinal: 0,
      });

      const entry = registry.getChat(CHAT_ID);
      expect(entry?.nextForkOrdinal).toBe(1);
    });

    it('normalizes current agent fields without preserving unknown persisted fields', async () => {
      const filePath = path.join(tmpDir, 'chats.json');
      await fs.writeFile(filePath, JSON.stringify({
        version: 2,
        sessions: {
          [CHAT_ID]: {
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

      const entry = fresh.getChat(CHAT_ID);
      expect(entry?.agentId).toBe('claude');
      expect(entry?.agentSessionId).toBe('native-1');
      expect(entry).not.toHaveProperty('unexpected');

      fresh.updateChat(CHAT_ID, { model: 'sonnet' });
      await fresh.flush();

      const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, 'chats.json'), 'utf8'));
      expect(persisted.sessions[CHAT_ID].agentId).toBe('claude');
      expect(persisted.sessions[CHAT_ID].agentSessionId).toBe('native-1');
      expect(persisted.sessions[CHAT_ID].unexpected).toBeUndefined();
    });

    it('migrates legacy persisted provider fields to current agent fields', async () => {
      const filePath = path.join(tmpDir, 'chats.json');
      await fs.writeFile(filePath, JSON.stringify({
        version: 1,
        sessions: {
          [CHAT_ID]: {
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

      const entry = fresh.getChat(CHAT_ID);
      expect(entry?.agentId).toBe('claude');
      expect(entry?.agentSessionId).toBe('native-1');

      const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
      expect(persisted.version).toBe(2);
      expect(persisted.sessions[CHAT_ID].agentId).toBe('claude');
      expect(persisted.sessions[CHAT_ID].agentSessionId).toBe('native-1');
      expect(persisted.sessions[CHAT_ID].provider).toBeUndefined();
      expect(persisted.sessions[CHAT_ID].providerSessionId).toBeUndefined();
    });
  });

  describe('updateChat', () => {
    it('patches allowed fields', () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' });
      registry.updateChat(CHAT_ID, { model: 'sonnet', nativePath: '/new.jsonl' });
      const entry = registry.getChat(CHAT_ID);
      expect(entry.model).toBe('sonnet');
      expect(entry.nativePath).toBe('/new.jsonl');
    });

    it('returns null for unknown chat', () => {
      const result = registry.updateChat('unknown', { model: 'opus' });
      expect(result).toBeNull();
    });

    it('resolves null for unknown chat when flush is requested', async () => {
      const result = await registry.updateChat('unknown', { model: 'opus' }, { flush: true });
      expect(result).toBeNull();
    });

    it('normalizes invalid mode patches', () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' });

      registry.updateChat(CHAT_ID, {
        permissionMode: 'bogus',
        thinkingMode: 'very-hard',
        claudeThinkingMode: 'sometimes',
      });

      const entry = registry.getChat(CHAT_ID);
      expect(entry?.permissionMode).toBe('default');
      expect(entry?.thinkingMode).toBe('none');
      expect(entry?.claudeThinkingMode).toBe('auto');
    });

    it('patches nextForkOrdinal with positive integers only', () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' });

      registry.updateChat(CHAT_ID, { nextForkOrdinal: 4 });
      expect(registry.getChat(CHAT_ID)?.nextForkOrdinal).toBe(4);

      registry.updateChat(CHAT_ID, { nextForkOrdinal: 0 });
      expect(registry.getChat(CHAT_ID)?.nextForkOrdinal).toBeUndefined();
    });

    it('flushes session identity patches immediately when requested', async () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' });

      await registry.updateChat(CHAT_ID, {
        agentSessionId: 'native-1',
        nativePath: '/tmp/native-1.jsonl',
      }, { flush: true });

      const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, 'chats.json'), 'utf8'));
      expect(persisted.sessions[CHAT_ID].agentSessionId).toBe('native-1');
      expect(persisted.sessions[CHAT_ID].nativePath).toBe('/tmp/native-1.jsonl');
    });
  });

  describe('removeChat', () => {
    it('removes a chat and emits chat-removed', () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' });
      const events = [];
      registry.onChatRemoved((id) => events.push(id));

      const removed = registry.removeChat(CHAT_ID);

      expect(removed).toBe(true);
      expect(registry.getChat(CHAT_ID)).toBeNull();
      expect(events).toEqual([CHAT_ID]);
    });

    it('returns false for unknown chat', () => {
      expect(registry.removeChat('unknown')).toBe(false);
    });
  });

  describe('chat-read-updated event', () => {
    it('emits chat-read-updated on lastReadAt patch', () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' });
      const events = [];
      registry.onChatReadUpdated((id, ts) => events.push({ id, ts }));

      registry.updateChat(CHAT_ID, { lastReadAt: '2026-01-01T00:00:00Z' });

      expect(events).toEqual([{ id: CHAT_ID, ts: '2026-01-01T00:00:00Z' }]);
    });

    it('does not emit for non-read patches', () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' });
      const events = [];
      registry.onChatReadUpdated((id, ts) => events.push({ id, ts }));

      registry.updateChat(CHAT_ID, { model: 'sonnet' });

      expect(events).toEqual([]);
    });
  });

  describe('project-path updates', () => {
    it('flushes the dedicated update and emits canonical identity metadata', async () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/old' });
      const listener = mock(() => undefined);
      registry.onChatProjectPathUpdated(listener);

      const result = await registry.updateProjectPath(CHAT_ID, {
        chatId: CHAT_ID,
        projectPath: '/new',
        effectiveProjectKey: '/real/new',
        previousProjectPath: '/old',
        previousEffectiveProjectKey: '/real/old',
        nativePath: '/new.jsonl',
      }, { flush: true });

      expect(result?.projectPath).toBe('/new');
      expect(result?.nativePath).toBe('/new.jsonl');
      expect(listener).toHaveBeenCalledWith({
        chatId: CHAT_ID,
        projectPath: '/new',
        effectiveProjectKey: '/real/new',
        previousProjectPath: '/old',
        previousEffectiveProjectKey: '/real/old',
      });
      const persisted = JSON.parse(await fs.readFile(path.join(tmpDir, 'chats.json'), 'utf8'));
      expect(persisted.sessions[CHAT_ID].projectPath).toBe('/new');
    });

    it('does not accept projectPath through generic updateChat', () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/old' });

      registry.updateChat(CHAT_ID, { projectPath: '/ignored' });

      expect(registry.getChat(CHAT_ID)?.projectPath).toBe('/old');
    });
  });

  describe('getChatByNativePath', () => {
    it('finds a chat by native path', () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p', nativePath: '/tmp/a.jsonl' });
      const result = registry.getChatByNativePath('/tmp/a.jsonl');
      expect(result).not.toBeNull();
      expect(result[0]).toBe(CHAT_ID);
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
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p', agentSessionId: 'ps1' });
      const result = registry.getChatByAgentSessionId('ps1');
      expect(result).not.toBeNull();
      expect(result[0]).toBe(CHAT_ID);
    });

    it('updates the agent session ID index when chats change', () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' });

      registry.updateChat(CHAT_ID, { agentSessionId: 'ps1' });
      expect(registry.getChatByAgentSessionId('ps1')?.[0]).toBe(CHAT_ID);

      registry.updateChat(CHAT_ID, { agentSessionId: 'ps2' });
      expect(registry.getChatByAgentSessionId('ps1')).toBeNull();
      expect(registry.getChatByAgentSessionId('ps2')?.[0]).toBe(CHAT_ID);

      registry.removeChat(CHAT_ID);
      expect(registry.getChatByAgentSessionId('ps2')).toBeNull();
    });

    it('builds the agent session ID index from persisted sessions', async () => {
      const filePath = path.join(tmpDir, 'chats.json');
      await fs.writeFile(filePath, JSON.stringify({
        version: 2,
        sessions: {
          [CHAT_ID]: {
            agentId: 'claude',
            agentSessionId: 'ps1',
            nativePath: '/tmp/ps1.jsonl',
            projectPath: '/p',
            model: 'opus',
          },
        },
      }));

      const fresh = new ChatRegistry(tmpDir);
      await fresh.init();

      expect(fresh.getChatByAgentSessionId('ps1')?.[0]).toBe(CHAT_ID);
    });

    it('returns null for unknown session ID', () => {
      expect(registry.getChatByAgentSessionId('unknown')).toBeNull();
    });
  });

  describe('listAllChats', () => {
    it('returns a shallow copy of all sessions', () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' });
      registry.addChat({ id: CHAT_ID_2, agentId: 'codex', model: 'gpt', projectPath: '/q' });
      const all = registry.listAllChats();
      expect(Object.keys(all)).toEqual([CHAT_ID, CHAT_ID_2]);
    });
  });

  describe('init from disk', () => {
    it('loads saved registry on init', async () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' });
      await registry.saveRegistry(registry.getRegistry());

      const fresh = new ChatRegistry(tmpDir);
      await fresh.init();
      expect(fresh.getChat(CHAT_ID)).not.toBeNull();
      expect(fresh.getChat(CHAT_ID).agentId).toBe('claude');
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
          [CHAT_ID]: {
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

      expect(fresh.getChat(CHAT_ID)?.permissionMode).toBe('default');
      expect(fresh.getChat(CHAT_ID)?.thinkingMode).toBe('none');
      expect(fresh.getChat(CHAT_ID)?.claudeThinkingMode).toBe('auto');
    });

    it('recovers missing agentSessionId from artificial native paths during migration', async () => {
      await fs.writeFile(path.join(tmpDir, 'chats.json'), JSON.stringify({
        version: 1,
        sessions: {
          [CHAT_ID]: {
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

      expect(fresh.getChat(CHAT_ID)?.agentSessionId).toBe('amp-thread-1');
      const changed = await fresh.reconcileSessions(async () => '/should-not-be-used');
      expect(changed).toBe(false);
      expect(fresh.getChat(CHAT_ID)?.nativePath).toBe('!amp:amp-thread-1');
    });

    it('recovers missing Cursor agentSessionId from transport-specific artificial native paths', async () => {
      await fs.writeFile(path.join(tmpDir, 'chats.json'), JSON.stringify({
        version: 2,
        sessions: {
          [ACP_CHAT_ID]: {
            agentId: 'cursor',
            nativePath: '!cursor-[ACP_CHAT_ID]:cursor-acp-session',
            projectPath: '/p',
            tags: [],
            model: 'default',
          },
          [STREAM_JSON_CHAT_ID]: {
            agentId: 'cursor',
            nativePath: '!cursor-stream-json:cursor-stream-session',
            projectPath: '/p',
            tags: [],
            model: 'default',
          },
        },
      }, null, 2), 'utf8');

      const fresh = new ChatRegistry(tmpDir);
      await fresh.init();

      expect(fresh.getChat(ACP_CHAT_ID)?.agentSessionId).toBe('cursor-acp-session');
      expect(fresh.getChat(STREAM_JSON_CHAT_ID)?.agentSessionId).toBe('cursor-stream-session');
      const changed = await fresh.reconcileSessions(async () => '/should-not-be-used');
      expect(changed).toBe(false);
    });

    it('recovers missing agentSessionId from jsonl native paths during migration', async () => {
      const nativePath = path.join(tmpDir, 'native-1.jsonl');
      await fs.writeFile(nativePath, '', 'utf8');
      await fs.writeFile(path.join(tmpDir, 'chats.json'), JSON.stringify({
        version: 1,
        sessions: {
          [CHAT_ID]: {
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

      expect(fresh.getChat(CHAT_ID)?.agentSessionId).toBe('native-1');
      const changed = await fresh.reconcileSessions(async () => '/should-not-be-used');
      expect(changed).toBe(false);
      expect(fresh.getChat(CHAT_ID)?.nativePath).toBe(nativePath);
    });
  });

  describe('reconcileSessions', () => {
    it('preserves chats missing agentSessionId', async () => {
      registry.addChat({ id: CHAT_ID, agentId: 'claude', model: 'opus', projectPath: '/p' });

      const changed = await registry.reconcileSessions(async () => '/should-not-be-used.jsonl');

      expect(changed).toBe(false);
      expect(registry.getChat(CHAT_ID)?.agentSessionId).toBeNull();
    });

    it('repairs missing nativePath when resolver succeeds', async () => {
      registry.addChat({
        id: CHAT_ID,
        agentId: 'claude',
        model: 'opus',
        projectPath: '/p',
        agentSessionId: 'ps1',
        nativePath: null,
      });

      const changed = await registry.reconcileSessions(async () => '/resolved/path.jsonl');

      expect(changed).toBe(true);
      expect(registry.getChat(CHAT_ID)?.nativePath).toBe('/resolved/path.jsonl');
    });

    it('preserves chats when nativePath reconciliation fails', async () => {
      registry.addChat({
        id: CHAT_ID,
        agentId: 'claude',
        model: 'opus',
        projectPath: '/p',
        agentSessionId: 'ps1',
        nativePath: null,
      });

      const changed = await registry.reconcileSessions(async () => null);

      expect(changed).toBe(false);
      expect(registry.getChat(CHAT_ID)?.agentSessionId).toBe('ps1');
      expect(registry.getChat(CHAT_ID)?.nativePath).toBeNull();
    });

    it('continues reconciling later chats when one nativePath resolver throws', async () => {
      registry.addChat({
        id: CHAT_ID,
        agentId: 'codex',
        model: 'gpt',
        projectPath: '/p',
        agentSessionId: 'ps1',
        nativePath: null,
      });
      registry.addChat({
        id: CHAT_ID_2,
        agentId: 'codex',
        model: 'gpt',
        projectPath: '/p',
        agentSessionId: 'ps2',
        nativePath: null,
      });
      const resolver = mock(async (session) => {
        if (session.agentSessionId === 'ps1') throw new Error('app-server unavailable');
        return '/resolved/ps2.jsonl';
      });

      const changed = await registry.reconcileSessions(resolver);

      expect(changed).toBe(true);
      expect(registry.getChat(CHAT_ID)?.agentSessionId).toBe('ps1');
      expect(registry.getChat(CHAT_ID)?.nativePath).toBeNull();
      expect(registry.getChat(CHAT_ID_2)?.agentSessionId).toBe('ps2');
      expect(registry.getChat(CHAT_ID_2)?.nativePath).toBe('/resolved/ps2.jsonl');
      expect(resolver).toHaveBeenCalledTimes(2);
    });

    it('returns false when registry is already consistent', async () => {
      const existingNativePath = path.join(tmpDir, 'existing.jsonl');
      await fs.writeFile(existingNativePath, '', 'utf8');

      registry.addChat({
        id: CHAT_ID,
        agentId: 'claude',
        model: 'opus',
        projectPath: '/p',
        agentSessionId: 'ps1',
        nativePath: existingNativePath,
      });

      const changed = await registry.reconcileSessions(async () => '/resolved/path.jsonl');

      expect(changed).toBe(false);
      expect(registry.getChat(CHAT_ID)?.nativePath).toBe(existingNativePath);
    });

    it('repairs stale nativePath when the stored file is missing', async () => {
      registry.addChat({
        id: CHAT_ID,
        agentId: 'claude',
        model: 'opus',
        projectPath: '/p',
        agentSessionId: 'ps1',
        nativePath: '/tmp/missing.jsonl',
      });

      const changed = await registry.reconcileSessions(async () => '/resolved/path.jsonl');

      expect(changed).toBe(true);
      expect(registry.getChat(CHAT_ID)?.nativePath).toBe('/resolved/path.jsonl');
    });

    it('preserves chats with stale nativePath when repair cannot resolve a replacement', async () => {
      registry.addChat({
        id: CHAT_ID,
        agentId: 'claude',
        model: 'gpt',
        projectPath: '/p',
        agentSessionId: 'thread-1',
        nativePath: '/tmp/missing-chat.jsonl',
      });

      const changed = await registry.reconcileSessions(async () => null);

      expect(changed).toBe(false);
      expect(registry.getChat(CHAT_ID)?.nativePath).toBe('/tmp/missing-chat.jsonl');
    });

    it('keeps Amp pseudo native paths without filesystem checks', async () => {
      registry.addChat({
        id: CHAT_ID,
        agentId: 'amp',
        model: 'default',
        projectPath: '/p',
        agentSessionId: 'amp-thread-1',
        nativePath: '!amp:amp-thread-1',
      });

      const changed = await registry.reconcileSessions(async () => '/should-not-be-used');

      expect(changed).toBe(false);
      expect(registry.getChat(CHAT_ID)?.nativePath).toBe('!amp:amp-thread-1');
    });
  });

  describe('chat ID invariants', () => {
    it('rejects invalid IDs before mutating the registry', () => {
      expect(() => registry.addChat({
        id: 'c1',
        agentId: 'claude',
        model: 'opus',
        projectPath: '/p',
      })).toThrow('Chat ID must be a valid 16-digit Unix-microsecond timestamp');
      expect(registry.listAllChats()).toEqual({});
    });

    it('fails initialization for invalid persisted keys without rewriting the file', async () => {
      const persisted = JSON.stringify({
        version: 2,
        sessions: {
          '178372590000007231252': {
            agentId: 'claude',
            projectPath: '/p',
            tags: [],
            model: 'opus',
          },
        },
      }, null, 2);
      const filePath = path.join(tmpDir, 'chats.json');
      await fs.writeFile(filePath, persisted, 'utf8');

      const fresh = new ChatRegistry(tmpDir);
      await expect(fresh.init()).rejects.toThrow(
        'Chat ID must be a valid 16-digit Unix-microsecond timestamp',
      );
      expect(await fs.readFile(filePath, 'utf8')).toBe(persisted);
    });

    it('fails initialization for malformed entries under valid keys', async () => {
      await fs.writeFile(path.join(tmpDir, 'chats.json'), JSON.stringify({
        version: 2,
        sessions: { [CHAT_ID]: null },
      }), 'utf8');

      const fresh = new ChatRegistry(tmpDir);
      await expect(fresh.init()).rejects.toThrow(`Invalid chat registry entry for ${CHAT_ID}`);
    });
  });
});
