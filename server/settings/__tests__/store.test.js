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
  await store.loadSettings();
}

function defaultExecutionDefaults() {
  return {
    permissionMode: 'default',
    thinkingMode: 'none',
    claudeThinkingMode: 'auto',
    ampAgentMode: 'smart',
  };
}

function startupSettings(overrides = {}) {
  return {
    recentAgentSettings: [],
    executionDefaults: {
      global: defaultExecutionDefaults(),
      byAgent: {},
    },
    ...overrides,
  };
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

    it('trims and persists app identity title settings', async () => {
      await store.setUiSettings({
        appIdentity: {
          title: ' Garcon - Work ',
        },
      });

      const ui = await store.getUiSettings();
      expect(ui.appIdentity).toEqual({
        title: 'Garcon - Work',
      });
    });

    it('clears app identity title settings with an empty object', async () => {
      await store.setUiSettings({
        appIdentity: {
          title: 'Garcon - Work',
        },
      });

      await store.setUiSettings({ appIdentity: {} });

      const ui = await store.getUiSettings();
      expect(ui.appIdentity).toBeUndefined();
    });

    it('normalizes invalid app identity settings out of loaded files', async () => {
      await writeRaw({
        ui: {
          theme: 'dark',
          appIdentity: {
            title: '   ',
          },
        },
        paths: {},
        chatNames: {},
        pinnedChatIds: [],
        normalChatIds: [],
        archivedChatIds: [],
      });

      const ui = await store.getUiSettings();
      expect(ui.theme).toBe('dark');
      expect(ui.appIdentity).toBeUndefined();
    });

    it('normalizes pinnedInsertPosition values', async () => {
      await writeRaw({
        ui: { pinnedInsertPosition: 'sideways' },
        paths: {},
        chatNames: {},
        pinnedChatIds: [],
        normalChatIds: [],
        archivedChatIds: [],
      });

      const loaded = await store.getUiSettings();
      expect(loaded.pinnedInsertPosition).toBe('top');

      await store.setUiSettings({ pinnedInsertPosition: 'bottom' });
      const saved = await store.getUiSettings();
      expect(saved.pinnedInsertPosition).toBe('bottom');
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

    it('sorts pinned project paths alphabetically when path settings change', async () => {
      await store.setPathSettings({
        pinnedProjectPaths: ['/workspace/zeta', ' /workspace/alpha ', '/workspace/beta', '/workspace/alpha'],
      });

      const paths = await store.getPathSettings();
      expect(paths.pinnedProjectPaths).toEqual([
        '/workspace/alpha',
        '/workspace/beta',
        '/workspace/zeta',
      ]);

      const persisted = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
      expect(persisted.paths.pinnedProjectPaths).toEqual(paths.pinnedProjectPaths);
    });

    it('normalizes persisted pinned project paths on load', async () => {
      await writeRaw({
        ui: {},
        paths: {
          pinnedProjectPaths: ['/workspace/zeta', ' /workspace/alpha ', 42, '/workspace/beta', '/workspace/alpha'],
        },
        chatNames: {},
      });

      const paths = await store.getPathSettings();
      expect(paths.pinnedProjectPaths).toEqual([
        '/workspace/alpha',
        '/workspace/beta',
        '/workspace/zeta',
      ]);
    });

    it('increments remote settings version and emits changes for ui/path updates', async () => {
      const events = [];
      store.onRemoteSettingsChanged(() => events.push('changed'));

      expect(await store.getRemoteSettingsVersion()).toBe(0);

      await store.setUiSettings({ theme: 'dark' });
      expect(await store.getRemoteSettingsVersion()).toBe(1);

      await store.setPathSettings({ lastDir: '/home' });
      expect(await store.getRemoteSettingsVersion()).toBe(2);
      expect(events).toEqual(['changed', 'changed']);
    });

    it('serves getter reads from cache until an explicit reload', async () => {
      await store.setUiSettings({ theme: 'dark' });
      await fs.writeFile(settingsFile(), JSON.stringify({
        ui: { theme: 'light' },
        paths: {},
        chatNames: {},
      }), 'utf8');

      expect(await store.getUiSettings()).toEqual({ theme: 'dark' });

      await store.loadSettings();

      expect(await store.getUiSettings()).toEqual({ theme: 'light' });
    });
  });

  describe('folder CRUD', () => {
    it('returns no folders by default', async () => {
      expect(await store.getFolders()).toEqual([]);
    });

    it('adds, updates, and removes folders', async () => {
      const folder = {
        id: 'folder-1',
        name: 'Pinned bugs',
        filter: { textTokens: ['bug'], tags: ['triage'], agents: ['codex'], models: ['gpt-5.4'] },
        createdAt: '2026-03-27T00:00:00.000Z',
      };

      await store.addFolder(folder);
      expect(await store.getFolders()).toEqual([folder]);

      const updated = await store.updateFolder('folder-1', {
        name: 'Pinned reviews',
        filter: { textTokens: ['review'], tags: ['triage'], agents: ['claude'], models: [] },
      });
      expect(updated).toEqual({
        ...folder,
        name: 'Pinned reviews',
        filter: { textTokens: ['review'], tags: ['triage'], agents: ['claude'], models: [] },
      });

      expect(await store.removeFolder('folder-1')).toBe(true);
      expect(await store.getFolders()).toEqual([]);
    });

    it('rejects duplicate folder IDs', async () => {
      const folder = {
        id: 'folder-1',
        name: 'Pinned bugs',
        filter: { textTokens: [], tags: [], agents: [], models: [] },
        createdAt: '2026-03-27T00:00:00.000Z',
      };

      await store.addFolder(folder);

      await expect(store.addFolder(folder)).rejects.toThrow('Folder with ID folder-1 already exists');
    });

		it('sanitizes malformed persisted folders on load', async () => {
			await writeRaw({
				ui: {},
				paths: {},
				chatNames: {},
				chatFolders: [
					{
						id: ' folder-1 ',
						name: ' Saved unread ',
						filter: {
							textTokens: [' follow-up ', 7],
							tags: [' ops ', null],
							agents: [' codex '],
							models: [' gpt-5 '],
							status: ' unread ',
						},
						createdAt: ' 2026-03-27T00:00:00.000Z ',
					},
					null,
					{ id: '', name: 'Missing id', filter: {}, createdAt: '2026-03-27T00:00:00.000Z' },
				],
			});

			expect(await store.getFolders()).toEqual([
				{
					id: 'folder-1',
					name: 'Saved unread',
					filter: {
						textTokens: ['follow-up'],
						tags: ['ops'],
						agents: ['codex'],
						models: ['gpt-5'],
						status: 'unread',
					},
					createdAt: '2026-03-27T00:00:00.000Z',
				},
			]);
		});
  });

  describe('saved search CRUD', () => {
    it('returns no saved searches by default', async () => {
      expect(await store.getSavedSearches()).toEqual([]);
    });

    it('adds, updates, and removes saved searches', async () => {
      const search = {
        id: 'search-1',
        title: 'Unread ops',
        query: 'status:unread tag:ops',
        showAsSidebarPill: true,
        showInSidebarMenu: false,
        showInSearchDialog: true,
        createdAt: '2026-03-27T00:00:00.000Z',
        updatedAt: '2026-03-27T00:00:00.000Z',
      };

      await store.addSavedSearch(search);
      expect(await store.getSavedSearches()).toEqual([search]);

      const updated = await store.updateSavedSearch('search-1', {
        title: 'Active ops',
        query: 'status:active tag:ops',
      });
      expect(updated.title).toBe('Active ops');
      expect(updated.query).toBe('status:active tag:ops');

      expect(await store.removeSavedSearch('search-1')).toBe(true);
      expect(await store.getSavedSearches()).toEqual([]);
    });

    it('rejects duplicate saved search IDs', async () => {
      const search = {
        id: 'search-1',
        title: null,
        query: 'status:active',
        showAsSidebarPill: false,
        showInSidebarMenu: true,
        showInSearchDialog: false,
        createdAt: '2026-03-27T00:00:00.000Z',
        updatedAt: '2026-03-27T00:00:00.000Z',
      };

      await store.addSavedSearch(search);
      await expect(store.addSavedSearch(search)).rejects.toThrow('Saved search with ID search-1 already exists');
    });

    it('reorders saved searches', async () => {
      const a = { id: 'a', title: null, query: 'qa', showAsSidebarPill: false, showInSidebarMenu: true, showInSearchDialog: false, createdAt: 't', updatedAt: 't' };
      const b = { id: 'b', title: null, query: 'qb', showAsSidebarPill: true, showInSidebarMenu: false, showInSearchDialog: false, createdAt: 't', updatedAt: 't' };
      const c = { id: 'c', title: null, query: 'qc', showAsSidebarPill: false, showInSidebarMenu: false, showInSearchDialog: true, createdAt: 't', updatedAt: 't' };

      await store.addSavedSearch(a);
      await store.addSavedSearch(b);
      await store.addSavedSearch(c);

      const result = await store.reorderSavedSearches(['a', 'b', 'c'], ['c', 'a', 'b']);
      expect(result).toEqual({ success: true });

      const searches = await store.getSavedSearches();
      expect(searches.map(s => s.id)).toEqual(['c', 'a', 'b']);
    });

    it('sanitizes malformed persisted saved searches on load', async () => {
      await writeRaw({
        ui: {},
        paths: {},
        chatNames: {},
        savedChatSearches: [
          {
            id: ' search-1 ',
            title: ' My search ',
            query: ' status:unread ',
            showAsSidebarPill: true,
            showInSidebarMenu: false,
            showInSearchDialog: false,
            createdAt: ' 2026-03-27T00:00:00.000Z ',
            updatedAt: ' 2026-03-27T00:00:00.000Z ',
          },
          null,
          { id: '', query: 'missing-id', createdAt: 't', updatedAt: 't' },
          { id: 'no-query', title: null, query: '', createdAt: 't', updatedAt: 't' },
          { id: 'no-visibility', title: '', query: 'status:active', showAsSidebarPill: false, showInSidebarMenu: false, showInSearchDialog: false, createdAt: 't', updatedAt: 't' },
        ],
      });

      const searches = await store.getSavedSearches();
      expect(searches).toEqual([
        {
          id: 'search-1',
          title: 'My search',
          query: 'status:unread',
          showAsSidebarPill: true,
          showInSidebarMenu: false,
          showInSearchDialog: false,
          createdAt: '2026-03-27T00:00:00.000Z',
          updatedAt: '2026-03-27T00:00:00.000Z',
        },
      ]);
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

  describe('ensureInNormal', () => {
    it('removes pinned chats, bumps the remote version, and emits changes', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: ['a'], normalChatIds: ['b'], archivedChatIds: [] });
      const events = [];
      store.onRemoteSettingsChanged(() => events.push('changed'));

      await store.ensureInNormal('a');

      expect(await store.getPinnedChatIds()).toEqual([]);
      expect(await store.getNormalChatIds()).toEqual(['a', 'b']);
      expect(await store.getRemoteSettingsVersion()).toBe(1);
      expect(events).toEqual(['changed']);
    });
  });

  describe('removeFromAllOrderLists', () => {
    it('removes the id from pinned, normal, and archived', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: ['a', 'b'], normalChatIds: ['c', 'a'], archivedChatIds: ['a', 'd'] });
      const events = [];
      store.onRemoteSettingsChanged(() => events.push('changed'));

      await store.removeFromAllOrderLists('a');

      expect(await store.getPinnedChatIds()).toEqual(['b']);
      expect(await store.getNormalChatIds()).toEqual(['c']);
      expect(await store.getArchivedChatIds()).toEqual(['d']);
      expect(await store.getRemoteSettingsVersion()).toBe(1);
      expect(events).toEqual(['changed']);
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
        features: { transcriptSearch: { enabled: false } },
        ui: {}, paths: {}, chatNames: {}, remoteSettingsVersion: 0,
        pinnedChatIds: [], normalChatIds: [], archivedChatIds: [],
        ...startupSettings(),
        chatFolders: [],
        savedChatSearches: [],
      });
    });

    it('returns empty settings for malformed JSON', async () => {
      await fs.writeFile(settingsFile(), 'not json{{{', 'utf8');
      const settings = await store.loadSettings();
      expect(settings).toEqual({
        features: { transcriptSearch: { enabled: false } },
        ui: {}, paths: {}, chatNames: {}, remoteSettingsVersion: 0,
        pinnedChatIds: [], normalChatIds: [], archivedChatIds: [],
        ...startupSettings(),
        chatFolders: [],
        savedChatSearches: [],
      });
    });

    it('migrates legacy startup settings on load', async () => {
      await writeRaw({
        ui: {}, paths: {}, chatNames: {},
        pinnedChatIds: [], normalChatIds: [], archivedChatIds: [],
        chatFolders: [],
        lastAgentId: 'codex',
        lastProjectPath: '/workspace/project',
        lastModel: 'gpt-5.4',
        lastApiProviderId: null,
        lastModelEndpointId: null,
        lastModelProtocol: null,
        lastPermissionMode: 'acceptEdits',
        lastThinkingMode: 'medium',
        lastClaudeThinkingMode: 'off',
        lastAmpAgentMode: 'deep',
      });

      const settings = await store.loadSettings();
      expect(settings.recentAgentSettings).toEqual([{
        agentId: 'codex',
        model: 'gpt-5.4',
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
      }]);
      expect(settings.paths.recentProjectPaths).toEqual(['/workspace/project']);
      expect(settings.executionDefaults.global).toEqual({
        permissionMode: 'acceptEdits',
        thinkingMode: 'medium',
        claudeThinkingMode: 'off',
        ampAgentMode: 'deep',
      });
      expect(settings.executionDefaults.byAgent.codex).toEqual(settings.executionDefaults.global);

      const persisted = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
      for (const key of ['last' + 'AgentId', 'last' + 'ProjectPath', 'last' + 'Model', 'last' + 'PermissionMode']) {
        expect(persisted[key]).toBeUndefined();
      }
    });

    it('normalizes invalid execution defaults on load', async () => {
      await writeRaw({
        ui: {}, paths: {}, chatNames: {},
        pinnedChatIds: [], normalChatIds: [], archivedChatIds: [],
        executionDefaults: {
          global: {
            permissionMode: 'bogus',
            thinkingMode: 'very-hard',
            claudeThinkingMode: 'sometimes',
            ampAgentMode: 'unreal',
          },
          byAgent: {
            codex: {
              permissionMode: 'manualBypass',
              thinkingMode: 'medium',
              claudeThinkingMode: 'sometimes',
            },
          },
        },
      });

      const settings = await store.loadSettings();
      expect(settings.executionDefaults.global).toEqual(defaultExecutionDefaults());
      expect(settings.executionDefaults.byAgent.codex).toEqual({
        permissionMode: 'manualBypass',
        thinkingMode: 'medium',
        claudeThinkingMode: 'auto',
      });
    });

    it('keeps cached settings unchanged when a mutation save fails', async () => {
      await store.setUiSettings({ theme: 'light' });
      await fs.rm(settingsFile(), { force: true });
      await fs.mkdir(settingsFile());

      await expect(store.setUiSettings({ theme: 'dark' })).rejects.toThrow();

      expect(store.getUiSettings()).toEqual({ theme: 'light' });
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
        ...startupSettings(),
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
        ...startupSettings(),
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
        ...startupSettings(),
      });

      await store.reconcileWithRegistry(mockRegistry);

      const settings = await store.loadSettings();
      expect(settings.pinnedChatIds).toEqual(['a']);
      expect(settings.normalChatIds).toEqual(['b']);
      expect(settings.archivedChatIds).toEqual([]);
    });
  });

  describe('togglePin', () => {
    it('pins a normal chat and emits list-changed plus remote-settings-changed', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: [], normalChatIds: ['a', 'b'], archivedChatIds: [] });
      const events = [];
      const remoteEvents = [];
      store.onListChanged((reason, chatId) => events.push({ reason, chatId }));
      store.onRemoteSettingsChanged(() => remoteEvents.push('changed'));

      const result = await store.togglePin('a');

      expect(result).toEqual({ isPinned: true });
      const settings = await store.loadSettings();
      expect(settings.pinnedChatIds).toEqual(['a']);
      expect(settings.normalChatIds).toEqual(['b']);
      expect(settings.remoteSettingsVersion).toBe(1);
      expect(events).toEqual([{ reason: 'pinned-toggled', chatId: 'a' }]);
      expect(remoteEvents).toEqual(['changed']);
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
      const remoteEvents = [];
      store.onListChanged((reason, chatId) => events.push({ reason, chatId }));
      store.onRemoteSettingsChanged(() => remoteEvents.push('changed'));

      const result = await store.toggleArchive('a');

      expect(result).toEqual({ isArchived: true });
      const settings = await store.loadSettings();
      expect(settings.archivedChatIds).toEqual(['a']);
      expect(settings.normalChatIds).toEqual(['b']);
      expect(settings.remoteSettingsVersion).toBe(0);
      expect(events).toEqual([{ reason: 'archive-toggled', chatId: 'a' }]);
      expect(remoteEvents).toEqual([]);
    });

    it('unarchives a chat and moves to normal', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: [], normalChatIds: ['b'], archivedChatIds: ['a'] });

      const result = await store.toggleArchive('a');

      expect(result).toEqual({ isArchived: false });
      const settings = await store.loadSettings();
      expect(settings.archivedChatIds).toEqual([]);
      expect(settings.normalChatIds).toEqual(['a', 'b']);
    });

    it('removes from pinned when archiving and emits remote-settings-changed', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: ['a', 'b'], normalChatIds: [], archivedChatIds: [] });
      const remoteEvents = [];
      store.onRemoteSettingsChanged(() => remoteEvents.push('changed'));

      await store.toggleArchive('a');

      const settings = await store.loadSettings();
      expect(settings.pinnedChatIds).toEqual(['b']);
      expect(settings.archivedChatIds).toEqual(['a']);
      expect(settings.remoteSettingsVersion).toBe(1);
      expect(remoteEvents).toEqual(['changed']);
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

    it('bumps remote settings version when reordering pinned chats', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: ['a', 'b', 'c'], normalChatIds: [], archivedChatIds: [] });
      const remoteEvents = [];
      store.onRemoteSettingsChanged(() => remoteEvents.push('changed'));

      const result = await store.reorderWindow('pinned', ['a', 'b'], ['b', 'a']);

      expect(result).toEqual({ success: true });
      expect(await store.getPinnedChatIds()).toEqual(['b', 'a', 'c']);
      expect(await store.getRemoteSettingsVersion()).toBe(1);
      expect(remoteEvents).toEqual(['changed']);
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

    it('bumps remote settings version when quickly reordering pinned chats', async () => {
      await writeRaw({ ui: {}, paths: {}, chatNames: {}, pinnedChatIds: ['a', 'b', 'c'], normalChatIds: [], archivedChatIds: [] });
      const remoteEvents = [];
      store.onRemoteSettingsChanged(() => remoteEvents.push('changed'));

      const result = await store.reorderRelative('c', 'a', 'above');

      expect(result).toEqual({ success: true });
      expect(await store.getPinnedChatIds()).toEqual(['c', 'a', 'b']);
      expect(await store.getRemoteSettingsVersion()).toBe(1);
      expect(remoteEvents).toEqual(['changed']);
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
        ...startupSettings(),
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

    it('does not lose ensureInNormal when recordChatStartup runs concurrently', async () => {
      await store.saveSettings({
        ui: {}, paths: {}, chatNames: {},
        pinnedChatIds: [], normalChatIds: [],
        archivedChatIds: [],
        ...startupSettings(),
      });

      await Promise.all([
        store.ensureInNormal('chat-1'),
        store.recordChatStartup({
          agentId: 'codex',
          projectPath: '/workspace/chat-2',
          model: 'gpt-5.4',
          permissionMode: 'bypassPermissions',
          thinkingMode: 'medium',
          claudeThinkingMode: 'off',
        }),
        store.ensureInNormal('chat-2'),
      ]);

      const settings = await store.loadSettings();
      expect(settings.normalChatIds).toContain('chat-1');
      expect(settings.normalChatIds).toContain('chat-2');
      expect(settings.recentAgentSettings[0]).toEqual({
        agentId: 'codex',
        model: 'gpt-5.4',
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
      });
      expect(settings.paths.recentProjectPaths).toEqual(['/workspace/chat-2']);
      expect(settings.executionDefaults.byAgent.codex).toEqual({
        permissionMode: 'bypassPermissions',
        thinkingMode: 'medium',
        claudeThinkingMode: 'off',
        ampAgentMode: 'smart',
      });
    });
  });

  describe('chat startup defaults', () => {
    it('defaults to empty recents and initialized execution defaults', async () => {
      expect(store.getRecentAgentSettings()).toEqual([]);
      expect(store.getRecentProjectPaths()).toEqual([]);
      expect(store.getExecutionDefaults()).toEqual({
        global: defaultExecutionDefaults(),
        byAgent: {},
      });
    });

    it('recordChatStartup persists the full startup selection', async () => {
      await store.recordChatStartup({
        agentId: 'codex',
        projectPath: '/workspace/project-a',
        model: 'gpt-5.4',
        permissionMode: 'bypassPermissions',
        thinkingMode: 'medium',
        claudeThinkingMode: 'on',
        ampAgentMode: 'deep',
      });

      expect(store.getRecentAgentSettings()).toEqual([{
        agentId: 'codex',
        model: 'gpt-5.4',
        apiProviderId: null,
        modelEndpointId: null,
        modelProtocol: null,
      }]);
      expect(store.getRecentProjectPaths()).toEqual(['/workspace/project-a']);
      expect(store.getExecutionDefaults().byAgent.codex).toEqual({
        permissionMode: 'bypassPermissions',
        thinkingMode: 'medium',
        claudeThinkingMode: 'on',
        ampAgentMode: 'deep',
      });
      expect(await store.getRemoteSettingsVersion()).toBe(1);
    });

    it('records endpoint-backed model targets', async () => {
      await store.recordChatStartup({
        agentId: 'direct-openai-compatible',
        projectPath: '/workspace/project-a',
        model: 'glm-5.1',
        apiProviderId: 'zai',
        modelEndpointId: 'zai_openai',
        modelProtocol: 'openai-compatible',
      });

      expect(store.getRecentAgentSettings()).toEqual([{
        agentId: 'direct-openai-compatible',
        model: 'glm-5.1',
        apiProviderId: 'zai',
        modelEndpointId: 'zai_openai',
        modelProtocol: 'openai-compatible',
      }]);
    });

    it('moves duplicate recent targets to the front and caps the list', async () => {
      for (let index = 0; index < 21; index += 1) {
        await store.recordChatStartup({
          agentId: 'codex',
          projectPath: `/workspace/project-${index}`,
          model: `gpt-5.${index}`,
        });
      }

      await store.recordChatStartup({
        agentId: 'codex',
        projectPath: '/workspace/project-5',
        model: 'gpt-5.5',
      });

      const recents = store.getRecentAgentSettings();
      expect(recents).toHaveLength(20);
      expect(recents[0].model).toBe('gpt-5.5');
      expect(recents.filter((entry) => entry.model === 'gpt-5.5')).toHaveLength(1);
      expect(store.getRecentProjectPaths()).toHaveLength(10);
      expect(store.getRecentProjectPaths()[0]).toBe('/workspace/project-5');
    });

    it('normalizes invalid execution values recorded with startup', async () => {
      await store.recordChatStartup({
        agentId: 'claude',
        projectPath: '/workspace/project-a',
        model: 'opus',
        permissionMode: 'bogus',
        thinkingMode: 'very-hard',
        claudeThinkingMode: 'sometimes',
        ampAgentMode: 'bogus',
      });

      expect(store.getExecutionDefaults().byAgent.claude).toEqual(defaultExecutionDefaults());
    });

    it('updates execution defaults for one agent without changing recents', async () => {
      await store.recordChatStartup({
        agentId: 'codex',
        projectPath: '/workspace/project-a',
        model: 'gpt-5.4',
      });
      await store.updateExecutionDefaultsForAgent('codex', {
        permissionMode: 'manualBypass',
        thinkingMode: 'medium',
      });

      expect(store.getRecentAgentSettings()[0].model).toBe('gpt-5.4');
      expect(store.getExecutionDefaults().byAgent.codex).toEqual({
        permissionMode: 'manualBypass',
        thinkingMode: 'medium',
        claudeThinkingMode: 'auto',
        ampAgentMode: 'smart',
      });
    });
  });

  describe('transcript search feature settings', () => {
    it('defaults missing and malformed persisted values to disabled', async () => {
      await writeRaw({ features: { transcriptSearch: { enabled: 'yes' } } });
      expect(store.getFeatureSettings()).toEqual({ transcriptSearch: { enabled: false } });
      const persisted = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
      expect(persisted.features).toEqual({ transcriptSearch: { enabled: false } });
    });

    it('persists enabled and increments the remote settings version once', async () => {
      const events = [];
      store.onRemoteSettingsChanged(() => events.push('changed'));
      await store.setTranscriptSearchEnabled(true);
      expect(store.getFeatureSettings()).toEqual({ transcriptSearch: { enabled: true } });
      expect(store.getRemoteSettingsVersion()).toBe(1);
      expect(events).toEqual(['changed']);

      const reloaded = new SettingsStore(tmpDir);
      await reloaded.init();
      expect(reloaded.getFeatureSettings()).toEqual({ transcriptSearch: { enabled: true } });
    });
  });
});
