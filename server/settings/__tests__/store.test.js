import { describe, it, expect, beforeEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { SettingsStore } from '../store.js';

let tmpDir;
let store;

function settingsFile() {
  return path.join(tmpDir, 'project-settings.json');
}

async function writeRaw(data) {
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(data, null, 2), 'utf8');
}

describe('settings store', () => {
  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    store = new SettingsStore(tmpDir);
    await store.init();
  });

  describe('load/save roundtrip', () => {
    it('loads and returns a settings file', async () => {
      await writeRaw({
        ui: { theme: 'dark' },
        paths: { lastDir: '/home' },
        chatNames: { '123': 'my chat' },
      });

      const settings = await store.loadSettings();
      expect(settings.ui.theme).toBe('dark');
      expect(settings.paths.lastDir).toBe('/home');
      expect(settings.chatNames['123']).toBe('my chat');
    });

    it('persists after save', async () => {
      const data = { ui: {}, paths: {}, chatNames: { a: 'title a' } };
      await store.saveSettings(data);

      const loaded = await store.loadSettings();
      expect(loaded.chatNames.a).toBe('title a');
    });

    it('strips unknown top-level fields during load', async () => {
      await writeRaw({
        ui: { theme: 'dark' },
        paths: {},
        chatNames: {},
        version: 3,
        chatSortOrder: 'date',
        projects: {},
      });

      const settings = await store.loadSettings();
      expect(settings.version).toBeUndefined();
      expect(settings.chatSortOrder).toBeUndefined();
      expect(settings.projects).toBeUndefined();
      expect(settings.ui.theme).toBe('dark');
    });
  });

  describe('session name CRUD', () => {
    it('getChatName returns null when unset', async () => {
      const name = store.getChatName('nonexistent');
      expect(name).toBeNull();
    });

    it('setSessionName writes and getChatName reads', async () => {
      await store.setSessionName('abc', 'My Title');
      const name = store.getChatName('abc');
      expect(name).toBe('My Title');
    });

    it('setSessionName with empty string deletes the entry', async () => {
      await store.setSessionName('abc', 'My Title');
      await store.setSessionName('abc', '');
      const name = store.getChatName('abc');
      expect(name).toBeNull();
    });

    it('setSessionName with whitespace-only deletes the entry', async () => {
      await store.setSessionName('abc', 'My Title');
      await store.setSessionName('abc', '   ');
      const name = store.getChatName('abc');
      expect(name).toBeNull();
    });

    it('setSessionName trims whitespace', async () => {
      await store.setSessionName('abc', '  Trimmed Title  ');
      const name = store.getChatName('abc');
      expect(name).toBe('Trimmed Title');
    });

    it('removeSessionName deletes the entry', async () => {
      await store.setSessionName('abc', 'My Title');
      await store.removeSessionName('abc');
      const name = store.getChatName('abc');
      expect(name).toBeNull();
    });

    it('removeSessionName is a no-op for missing keys', async () => {
      await store.removeSessionName('nonexistent');
      const settings = await store.loadSettings();
      expect(settings.chatNames).toEqual({});
    });

    it('emits session-name-changed when a non-empty name is set', async () => {
      const events = [];
      store.onSessionNameChanged((chatId, title) => events.push({ chatId, title }));
      await store.setSessionName('abc', 'My Title');
      expect(events).toEqual([{ chatId: 'abc', title: 'My Title' }]);
    });

    it('emits session-name-changed with empty string when name is cleared', async () => {
      await store.setSessionName('abc', 'My Title');
      const events = [];
      store.onSessionNameChanged((chatId, title) => events.push({ chatId, title }));
      await store.setSessionName('abc', '');
      expect(events).toEqual([{ chatId: 'abc', title: '' }]);
    });
  });

  describe('ui and paths settings', () => {
    it('getUiSettings returns empty object by default', async () => {
      expect(await store.getUiSettings()).toEqual({});
    });

    it('setUiSettings merges a patch', async () => {
      await store.setUiSettings({ theme: 'dark' });
      await store.setUiSettings({ fontSize: 14 });
      const ui = await store.getUiSettings();
      expect(ui.theme).toBe('dark');
      expect(ui.fontSize).toBe(14);
    });

    it('getPathSettings returns empty object by default', async () => {
      expect(await store.getPathSettings()).toEqual({});
    });

    it('setPathSettings merges a patch', async () => {
      await store.setPathSettings({ lastDir: '/home' });
      await store.setPathSettings({ recentDirs: ['/a'] });
      const paths = await store.getPathSettings();
      expect(paths.lastDir).toBe('/home');
      expect(paths.recentDirs).toEqual(['/a']);
    });
  });

  describe('ordering list getters', () => {
    it('getPinnedChatIds returns empty array by default', async () => {
      expect(await store.getPinnedChatIds()).toEqual([]);
    });

    it('getArchivedChatIds returns empty array by default', async () => {
      expect(await store.getArchivedChatIds()).toEqual([]);
    });

    it('getNormalChatIds returns empty array by default', async () => {
      expect(await store.getNormalChatIds()).toEqual([]);
    });

    it('getPinnedChatIds reads from persisted settings', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: ['a', 'b'], normalChatIds: [], archivedChatIds: [] });
      expect(await store.getPinnedChatIds()).toEqual(['a', 'b']);
    });
  });

  describe('insertNormalChatIdTop', () => {
    it('prepends to the list', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: [], normalChatIds: ['a', 'b'], archivedChatIds: [] });
      await store.insertNormalChatIdTop('c');
      expect(await store.getNormalChatIds()).toEqual(['c', 'a', 'b']);
    });

    it('moves existing entry to top without duplicating', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: [], normalChatIds: ['a', 'b'], archivedChatIds: [] });
      await store.insertNormalChatIdTop('a');
      expect(await store.getNormalChatIds()).toEqual(['a', 'b']);
    });
  });

  describe('removeFromAllOrderLists', () => {
    it('removes the id from pinned, normal, and archived', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: ['a', 'b'], normalChatIds: ['c', 'a'], archivedChatIds: ['a', 'd'] });
      await store.removeFromAllOrderLists('a');
      expect(await store.getPinnedChatIds()).toEqual(['b']);
      expect(await store.getNormalChatIds()).toEqual(['c']);
      expect(await store.getArchivedChatIds()).toEqual(['d']);
    });

    it('is a no-op when id is not in any list', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: ['a'], normalChatIds: ['b'], archivedChatIds: ['c'] });
      await store.removeFromAllOrderLists('z');
      expect(await store.getPinnedChatIds()).toEqual(['a']);
      expect(await store.getNormalChatIds()).toEqual(['b']);
      expect(await store.getArchivedChatIds()).toEqual(['c']);
    });
  });

  describe('error handling', () => {
    it('returns empty settings for missing file', async () => {
      const settings = await store.loadSettings();
      expect(settings).toEqual({
        ui: {}, paths: {}, chatNames: {},
        pinnedChatIds: [], normalChatIds: [], archivedChatIds: [],
        lastProvider: 'claude', lastModel: '',
        lastPermissionMode: 'default', lastThinkingMode: 'none',
      });
    });

    it('returns empty settings for malformed JSON', async () => {
      await fs.writeFile(settingsFile(), 'not json{{{', 'utf8');
      const settings = await store.loadSettings();
      expect(settings).toEqual({
        ui: {}, paths: {}, chatNames: {},
        pinnedChatIds: [], normalChatIds: [], archivedChatIds: [],
        lastProvider: 'claude', lastModel: '',
        lastPermissionMode: 'default', lastThinkingMode: 'none',
      });
    });
  });

  describe('reconcileWithRegistry', () => {
    it('adds missing chat IDs to normalChatIds', async () => {
      const mockRegistry = {
        listAllChats: () => ({ 'a': {}, 'b': {}, 'c': {} }),
      };
      await store.saveSettings({
        ui: {}, paths: {}, chatNames: {},
        pinnedChatIds: ['a'],
        normalChatIds: [],
        archivedChatIds: [],
        lastProvider: 'claude',
        lastModel: '',
        lastPermissionMode: 'default',
        lastThinkingMode: 'none',
      });

      await store.reconcileWithRegistry(mockRegistry);

      const settings = await store.loadSettings();
      expect(settings.pinnedChatIds).toEqual(['a']);
      expect(settings.normalChatIds).toContain('b');
      expect(settings.normalChatIds).toContain('c');
    });

    it('removes unknown IDs from ordering lists', async () => {
      const mockRegistry = {
        listAllChats: () => ({ 'a': {} }),
      };
      await store.saveSettings({
        ui: {}, paths: {}, chatNames: {},
        pinnedChatIds: ['a', 'gone'],
        normalChatIds: ['also-gone'],
        archivedChatIds: [],
        lastProvider: 'claude',
        lastModel: '',
        lastPermissionMode: 'default',
        lastThinkingMode: 'none',
      });

      await store.reconcileWithRegistry(mockRegistry);

      const settings = await store.loadSettings();
      expect(settings.pinnedChatIds).toEqual(['a']);
      expect(settings.normalChatIds).toEqual([]);
    });

    it('resolves cross-list duplicates by precedence', async () => {
      const mockRegistry = {
        listAllChats: () => ({ 'a': {}, 'b': {} }),
      };
      await store.saveSettings({
        ui: {}, paths: {}, chatNames: {},
        pinnedChatIds: ['a'],
        normalChatIds: ['a', 'b'],
        archivedChatIds: ['a'],
        lastProvider: 'claude',
        lastModel: '',
        lastPermissionMode: 'default',
        lastThinkingMode: 'none',
      });

      await store.reconcileWithRegistry(mockRegistry);

      const settings = await store.loadSettings();
      expect(settings.pinnedChatIds).toEqual(['a']);
      expect(settings.normalChatIds).toEqual(['b']);
      expect(settings.archivedChatIds).toEqual([]);
    });
  });

  describe('togglePin', () => {
    it('pins a normal chat and emits list-changed', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: [], normalChatIds: ['a', 'b'], archivedChatIds: [] });
      const events = [];
      store.onListChanged((reason, chatId) => events.push({ reason, chatId }));

      const result = await store.togglePin('a');

      expect(result).toEqual({ isPinned: true });
      const settings = await store.loadSettings();
      expect(settings.pinnedChatIds).toEqual(['a']);
      expect(settings.normalChatIds).toEqual(['b']);
      expect(events).toEqual([{ reason: 'pinned-toggled', chatId: 'a' }]);
    });

    it('unpins a pinned chat and moves to normal', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: ['a', 'b'], normalChatIds: ['c'], archivedChatIds: [] });

      const result = await store.togglePin('a');

      expect(result).toEqual({ isPinned: false });
      const settings = await store.loadSettings();
      expect(settings.pinnedChatIds).toEqual(['b']);
      expect(settings.normalChatIds).toEqual(['a', 'c']);
    });

    it('respects pinnedInsertPosition=bottom', async () => {
      await writeRaw({ ui: { pinnedInsertPosition: 'bottom' }, paths: {}, chatNames: {}, pinnedChatIds: ['x'], normalChatIds: ['a'], archivedChatIds: [] });

      await store.togglePin('a');

      const settings = await store.loadSettings();
      expect(settings.pinnedChatIds).toEqual(['x', 'a']);
    });
  });

  describe('toggleArchive', () => {
    it('archives a normal chat and emits list-changed', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: [], normalChatIds: ['a', 'b'], archivedChatIds: [] });
      const events = [];
      store.onListChanged((reason, chatId) => events.push({ reason, chatId }));

      const result = await store.toggleArchive('a');

      expect(result).toEqual({ isArchived: true });
      const settings = await store.loadSettings();
      expect(settings.archivedChatIds).toEqual(['a']);
      expect(settings.normalChatIds).toEqual(['b']);
      expect(events).toEqual([{ reason: 'archive-toggled', chatId: 'a' }]);
    });

    it('unarchives a chat and moves to normal', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: [], normalChatIds: ['b'], archivedChatIds: ['a'] });

      const result = await store.toggleArchive('a');

      expect(result).toEqual({ isArchived: false });
      const settings = await store.loadSettings();
      expect(settings.archivedChatIds).toEqual([]);
      expect(settings.normalChatIds).toEqual(['a', 'b']);
    });

    it('removes from pinned when archiving', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: ['a', 'b'], normalChatIds: [], archivedChatIds: [] });

      await store.toggleArchive('a');

      const settings = await store.loadSettings();
      expect(settings.pinnedChatIds).toEqual(['b']);
      expect(settings.archivedChatIds).toEqual(['a']);
    });
  });

  describe('reorderWindow', () => {
    it('reorders a contiguous window within a list', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: [], normalChatIds: ['a', 'b', 'c', 'd'], archivedChatIds: [] });
      const events = [];
      store.onListChanged((reason, chatId) => events.push({ reason, chatId }));

      const result = await store.reorderWindow('normal', ['b', 'c'], ['c', 'b']);

      expect(result).toEqual({ success: true });
      const settings = await store.loadSettings();
      expect(settings.normalChatIds).toEqual(['a', 'c', 'b', 'd']);
      expect(events[0].reason).toBe('chats-reordered');
    });

    it('rejects empty oldOrder', async () => {
      const result = await store.reorderWindow('normal', [], []);
      expect(result.success).toBe(false);
    });

    it('rejects mismatched IDs between oldOrder and newOrder', async () => {
      const result = await store.reorderWindow('normal', ['a', 'b'], ['a', 'c']);
      expect(result.success).toBe(false);
    });
  });

  describe('reorderRelative', () => {
    it('moves a chat above another in the same group', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: [], normalChatIds: ['a', 'b', 'c'], archivedChatIds: [] });

      const result = await store.reorderRelative('c', 'a', 'above');

      expect(result).toEqual({ success: true });
      const settings = await store.loadSettings();
      expect(settings.normalChatIds).toEqual(['c', 'a', 'b']);
    });

    it('rejects cross-group reorder', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: ['a'], normalChatIds: ['b'], archivedChatIds: [] });

      const result = await store.reorderRelative('a', 'b', 'above');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Cross-group');
    });
  });

  describe('concurrent mutation safety', () => {
    it('does not lose ensureInNormal when setSessionName runs concurrently', async () => {
      await store.saveSettings({
        ui: {}, paths: {}, chatNames: {},
        pinnedChatIds: [], normalChatIds: ['existing'],
        archivedChatIds: [],
        lastProvider: 'claude', lastModel: '',
        lastPermissionMode: 'default', lastThinkingMode: 'none',
      });

      // Fire both mutations concurrently — without the lock, the second
      // write would overwrite the first, losing the normalChatIds update.
      await Promise.all([
        store.ensureInNormal('new-chat'),
        store.setSessionName('existing', 'title'),
      ]);

      const settings = await store.loadSettings();
      expect(settings.normalChatIds).toContain('new-chat');
      expect(settings.chatNames['existing']).toBe('title');
    });

    it('does not lose ensureInNormal when setLastChatDefaults runs concurrently', async () => {
      await store.saveSettings({
        ui: {}, paths: {}, chatNames: {},
        pinnedChatIds: [], normalChatIds: [],
        archivedChatIds: [],
        lastProvider: 'claude', lastModel: '',
        lastPermissionMode: 'default', lastThinkingMode: 'none',
      });

      await Promise.all([
        store.ensureInNormal('chat-1'),
        store.setLastChatDefaults({
          provider: 'codex',
          model: 'gpt-5.4',
          permissionMode: 'bypassPermissions',
          thinkingMode: 'think-hard',
        }),
        store.ensureInNormal('chat-2'),
      ]);

      const settings = await store.loadSettings();
      expect(settings.normalChatIds).toContain('chat-1');
      expect(settings.normalChatIds).toContain('chat-2');
      expect(settings.lastProvider).toBe('codex');
      expect(settings.lastModel).toBe('gpt-5.4');
      expect(settings.lastPermissionMode).toBe('bypassPermissions');
      expect(settings.lastThinkingMode).toBe('think-hard');
    });
  });

  describe('chat startup defaults', () => {
    it('getLastProvider defaults to "claude"', async () => {
      expect(await store.getLastProvider()).toBe('claude');
    });

    it('getLastModel defaults to empty string', async () => {
      expect(await store.getLastModel()).toBe('');
    });

    it('setLastChatDefaults persists the full startup selection', async () => {
      await store.setLastChatDefaults({
        provider: 'codex',
        model: 'gpt-5.4',
        permissionMode: 'bypassPermissions',
        thinkingMode: 'think-hard',
      });
      expect(await store.getLastProvider()).toBe('codex');
      expect(await store.getLastModel()).toBe('gpt-5.4');
      expect(await store.getLastPermissionMode()).toBe('bypassPermissions');
      expect(await store.getLastThinkingMode()).toBe('think-hard');
    });

    it('preserves unspecified fields when updating only one startup setting', async () => {
      await store.setLastChatDefaults({
        provider: 'codex',
        model: 'gpt-5.4',
        permissionMode: 'bypassPermissions',
        thinkingMode: 'think-hard',
      });
      await store.setLastPermissionMode('acceptEdits');
      expect(await store.getLastProvider()).toBe('codex');
      expect(await store.getLastModel()).toBe('gpt-5.4');
      expect(await store.getLastPermissionMode()).toBe('acceptEdits');
      expect(await store.getLastThinkingMode()).toBe('think-hard');
    });

    it('getLastPermissionMode defaults to "default"', async () => {
      expect(await store.getLastPermissionMode()).toBe('default');
    });

    it('setLastPermissionMode persists the mode', async () => {
      await store.setLastPermissionMode('bypassPermissions');
      expect(await store.getLastPermissionMode()).toBe('bypassPermissions');
    });

    it('getLastThinkingMode defaults to "none"', async () => {
      expect(await store.getLastThinkingMode()).toBe('none');
    });

    it('setLastThinkingMode persists the mode', async () => {
      await store.setLastThinkingMode('think-hard');
      expect(await store.getLastThinkingMode()).toBe('think-hard');
    });
  });
});
