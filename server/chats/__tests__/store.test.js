import { describe, it, expect, beforeEach } from 'bun:test';
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
      registry.addChat({ id: 'c1', provider: 'claude', model: 'opus', projectPath: '/p' });
      const entry = registry.getChat('c1');
      expect(entry).not.toBeNull();
      expect(entry.provider).toBe('claude');
      expect(entry.model).toBe('opus');
    });

    it('throws on duplicate chat ID', () => {
      registry.addChat({ id: 'c1', provider: 'claude', model: 'opus', projectPath: '/p' });
      expect(() => registry.addChat({ id: 'c1', provider: 'claude', model: 'opus', projectPath: '/p' }))
        .toThrow('already exists');
    });

    it('returns null for unknown chat', () => {
      expect(registry.getChat('unknown')).toBeNull();
    });
  });

  describe('updateChat', () => {
    it('patches allowed fields', () => {
      registry.addChat({ id: 'c1', provider: 'claude', model: 'opus', projectPath: '/p' });
      registry.updateChat('c1', { model: 'sonnet', nativePath: '/new.jsonl' });
      const entry = registry.getChat('c1');
      expect(entry.model).toBe('sonnet');
      expect(entry.nativePath).toBe('/new.jsonl');
    });

    it('returns null for unknown chat', () => {
      const result = registry.updateChat('unknown', { model: 'opus' });
      expect(result).toBeNull();
    });
  });

  describe('removeChat', () => {
    it('removes a chat and emits chat-removed', () => {
      registry.addChat({ id: 'c1', provider: 'claude', model: 'opus', projectPath: '/p' });
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
      registry.addChat({ id: 'c1', provider: 'claude', model: 'opus', projectPath: '/p' });
      const events = [];
      registry.onChatReadUpdated((id, ts) => events.push({ id, ts }));

      registry.updateChat('c1', { lastReadAt: '2026-01-01T00:00:00Z' });

      expect(events).toEqual([{ id: 'c1', ts: '2026-01-01T00:00:00Z' }]);
    });

    it('does not emit for non-read patches', () => {
      registry.addChat({ id: 'c1', provider: 'claude', model: 'opus', projectPath: '/p' });
      const events = [];
      registry.onChatReadUpdated((id, ts) => events.push({ id, ts }));

      registry.updateChat('c1', { model: 'sonnet' });

      expect(events).toEqual([]);
    });
  });

  describe('getChatByNativePath', () => {
    it('finds a chat by native path', () => {
      registry.addChat({ id: 'c1', provider: 'claude', model: 'opus', projectPath: '/p', nativePath: '/tmp/a.jsonl' });
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

  describe('getChatByProviderSessionId', () => {
    it('finds a chat by provider session ID', () => {
      registry.addChat({ id: 'c1', provider: 'claude', model: 'opus', projectPath: '/p', providerSessionId: 'ps1' });
      const result = registry.getChatByProviderSessionId('ps1');
      expect(result).not.toBeNull();
      expect(result[0]).toBe('c1');
    });

    it('returns null for unknown session ID', () => {
      expect(registry.getChatByProviderSessionId('unknown')).toBeNull();
    });
  });

  describe('listAllChats', () => {
    it('returns a shallow copy of all sessions', () => {
      registry.addChat({ id: 'c1', provider: 'claude', model: 'opus', projectPath: '/p' });
      registry.addChat({ id: 'c2', provider: 'codex', model: 'gpt', projectPath: '/q' });
      const all = registry.listAllChats();
      expect(Object.keys(all)).toEqual(['c1', 'c2']);
    });
  });

  describe('init from disk', () => {
    it('loads saved registry on init', async () => {
      registry.addChat({ id: 'c1', provider: 'claude', model: 'opus', projectPath: '/p' });
      await registry.saveRegistry(registry.getRegistry());

      const fresh = new ChatRegistry(tmpDir);
      await fresh.init();
      expect(fresh.getChat('c1')).not.toBeNull();
      expect(fresh.getChat('c1').provider).toBe('claude');
    });

    it('returns empty registry for missing file', async () => {
      const emptyDir = path.join(os.tmpdir(), `registry-empty-${Date.now()}`);
      await fs.mkdir(emptyDir, { recursive: true });
      const fresh = new ChatRegistry(emptyDir);
      await fresh.init();
      expect(Object.keys(fresh.listAllChats())).toEqual([]);
    });
  });

  describe('reconcileSessions', () => {
    it('discards chats missing providerSessionId', async () => {
      registry.addChat({ id: 'c1', provider: 'claude', model: 'opus', projectPath: '/p' });

      const changed = await registry.reconcileSessions(async () => '/should-not-be-used.jsonl');

      expect(changed).toBe(true);
      expect(registry.getChat('c1')).toBeNull();
    });

    it('repairs missing nativePath when resolver succeeds', async () => {
      registry.addChat({
        id: 'c1',
        provider: 'claude',
        model: 'opus',
        projectPath: '/p',
        providerSessionId: 'ps1',
        nativePath: null,
      });

      const changed = await registry.reconcileSessions(async () => '/resolved/path.jsonl');

      expect(changed).toBe(true);
      expect(registry.getChat('c1')?.nativePath).toBe('/resolved/path.jsonl');
    });

    it('discards chats when nativePath reconciliation fails', async () => {
      registry.addChat({
        id: 'c1',
        provider: 'claude',
        model: 'opus',
        projectPath: '/p',
        providerSessionId: 'ps1',
        nativePath: null,
      });

      const changed = await registry.reconcileSessions(async () => null);

      expect(changed).toBe(true);
      expect(registry.getChat('c1')).toBeNull();
    });

    it('returns false when registry is already consistent', async () => {
      const existingNativePath = path.join(tmpDir, 'existing.jsonl');
      await fs.writeFile(existingNativePath, '', 'utf8');

      registry.addChat({
        id: 'c1',
        provider: 'claude',
        model: 'opus',
        projectPath: '/p',
        providerSessionId: 'ps1',
        nativePath: existingNativePath,
      });

      const changed = await registry.reconcileSessions(async () => '/resolved/path.jsonl');

      expect(changed).toBe(false);
      expect(registry.getChat('c1')?.nativePath).toBe(existingNativePath);
    });

    it('repairs stale nativePath when the stored file is missing', async () => {
      registry.addChat({
        id: 'c1',
        provider: 'claude',
        model: 'opus',
        projectPath: '/p',
        providerSessionId: 'ps1',
        nativePath: '/tmp/missing.jsonl',
      });

      const changed = await registry.reconcileSessions(async () => '/resolved/path.jsonl');

      expect(changed).toBe(true);
      expect(registry.getChat('c1')?.nativePath).toBe('/resolved/path.jsonl');
    });

    it('keeps Amp pseudo native paths without filesystem checks', async () => {
      registry.addChat({
        id: 'c1',
        provider: 'amp',
        model: 'default',
        projectPath: '/p',
        providerSessionId: 'amp-thread-1',
        nativePath: '!amp:amp-thread-1',
      });

      const changed = await registry.reconcileSessions(async () => '/should-not-be-used');

      expect(changed).toBe(false);
      expect(registry.getChat('c1')?.nativePath).toBe('!amp:amp-thread-1');
    });
  });
});
