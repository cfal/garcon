import assert from 'node:assert/strict';
import { SettingsStore } from '../../../../server/controller/settings/store.ts';

assert.equal(Bun.version, '1.4.3');
const action = Bun.argv[2];
const store = new SettingsStore(Bun.argv[3]!);
await store.init();
const time = '2020-01-02T03:04:05.000Z';

if (action === 'write') {
  await store.saveSettings({
    lastAgentId: 'claude',
    lastModel: 'fixture-model',
    lastProjectPath: '/fixture/project',
    chatNames: { '1000000000000001': 'Original chat' },
    chatFolders: [{ id: 'folder', name: 'Fixture', filter: { tags: [' fixture-tag '] }, createdAt: time }],
    savedChatSearches: [{
      id: 'search', title: null, query: 'fixture search', showAsSidebarPill: true,
      createdAt: time, updatedAt: time,
    }],
  });
  await store.setUiSettings({ appIdentity: { title: ' Bun Title ' }, arbitraryUiPreference: { keep: true } });
} else if (action === 'verify-and-update') {
  assert.deepEqual(store.getUiSettings().appIdentity, { title: 'Rust Title' });
  assert.deepEqual(store.getUiSettings().arbitraryUiPreference, { keep: true });
  assert.equal(store.getRemoteSettingsVersion(), 4);
  assert.equal(store.getChatName('1000000000000001'), 'Original chat');
  assert.equal(store.getChatName('1000000000000002'), 'Rust chat');
  assert.deepEqual(store.getPinnedChatIds(), ['1000000000000002']);
  assert.deepEqual(store.getRecentAgentSettings().map(entry => entry.model), ['rust-model', 'fixture-model']);
  assert.deepEqual(store.getRecentProjectPaths(), ['/fixture/rust', '/fixture/project']);
  assert.equal(store.getExecutionDefaults().byAgent.codex?.thinkingMode, 'high');
  assert.equal(store.getFolders()[0]?.filter.tags[0], 'fixture-tag');
  assert.equal(store.getSavedSearches()[0]?.query, 'fixture search');
  await store.setFeatureSettings({ transcriptSearch: { enabled: true } });
} else {
  throw new Error(`Unknown fixture action: ${action}`);
}
