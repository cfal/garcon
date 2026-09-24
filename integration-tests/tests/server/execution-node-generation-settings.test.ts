import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GENERATION_UI_SETTING_KEYS, normalizeRemoteSettingsSnapshot, type RemoteSettingsSnapshot } from '../../../common/settings.js';
import { SettingsChangedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('malformed generation updates preserve durable selections and readable settings', async () => {
  await withIntegrationFixture('execution-node-generation-settings', async (fixture) => {
    const { client } = fixture;
    const node = await client.post<{ id: string }>('/api/v1/execution-nodes', {
      label: 'Offline generator', direction: 'node-connects',
    });
    const agent = fixture.directAgents.openAi;
    const selection = {
      nodeId: node.id, agentId: agent.agentId, model: agent.provider.model,
      apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
      modelProtocol: agent.provider.protocol,
    };
    await client.updateSettings({ ui: Object.fromEntries(GENERATION_UI_SETTING_KEYS.map((key) => [key, selection])) });
    const saved = await readFile(join(fixture.dirs.workspace, 'project-settings.json'), 'utf8');

    for (const key of GENERATION_UI_SETTING_KEYS) {
      await expect(client.put('/api/v1/app/settings', { ui: { [key]: { ...selection, agentId: '!' } } }))
        .rejects.toMatchObject({ status: 400, body: { errorCode: 'INVALID_REMOTE_SETTINGS' } });
      for (const malformed of [null, [], '', 0, false]) {
        await client.put('/api/v1/app/settings', { ui: { [key]: malformed } });
      }
    }
    expect(await readFile(join(fixture.dirs.workspace, 'project-settings.json'), 'utf8')).toBe(saved);
    await fixture.crashAndRestartGarcon();
    const snapshot = await fixture.client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
    for (const key of GENERATION_UI_SETTING_KEYS) {
      expect(snapshot.ui[key]).toMatchObject(selection);
      expect(snapshot.uiEffective[key]?.nodeId).toBe(node.id);
    }
    await fixture.client.updateSettings({ ui: Object.fromEntries(GENERATION_UI_SETTING_KEYS.map((key) => [key, {}])) });
    const reset = await fixture.client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
    for (const key of GENERATION_UI_SETTING_KEYS) {
      expect(reset.ui[key]).toBeUndefined();
      expect(reset.uiEffective[key]?.nodeId).toBe('local');
    }
  }, { executionBackend: 'in-process' });
}, 30_000);

test('malformed persisted generation targets remain repairable through settings reads and broadcasts', async () => {
  await withIntegrationFixture('unavailable-generation-settings', async (fixture) => {
    const node = '22222222-2222-4222-8222-222222222222';
    const agent = fixture.directAgents.openAi;
    const selections = {
      chatTitle: { nodeId: 'not-a-node', agentId: agent.agentId, model: agent.provider.model, enabled: true },
      agentSwitchCompaction: { nodeId: node, enabled: true },
      commitMessage: { nodeId: 42, agentId: agent.agentId, model: agent.provider.model },
      promptRefinement: { nodeId: node, model: agent.provider.model },
    };
    await fixture.restartGarcon({ beforeStart: async () => {
      const path = join(fixture.dirs.workspace, 'project-settings.json');
      const stored = JSON.parse(await readFile(path, 'utf8'));
      stored.ui = { ...stored.ui, ...selections, appIdentity: { title: 'Synthetic retained title' } };
      await writeFile(path, JSON.stringify(stored));
    } });
    const client = fixture.client;
    const check = (snapshot: RemoteSettingsSnapshot) => {
      const parsed = normalizeRemoteSettingsSnapshot(snapshot);
      expect(parsed).not.toBeNull();
      expect(parsed?.ui.appIdentity).toEqual({ title: 'Synthetic retained title' });
      for (const key of GENERATION_UI_SETTING_KEYS) {
        expect(parsed?.ui[key]).toMatchObject({ ...selections[key], nodeId: key === 'commitMessage' ? '' : selections[key].nodeId });
        expect(parsed?.uiEffective[key]).toBeUndefined();
      }
    };
    check(await client.get<RemoteSettingsSnapshot>('/api/v1/app/settings'));
    const observer = await fixture.connectObserver('unavailable-generation-settings');
    const afterIndex = observer.markEvents();
    check((await client.updateSettings({ ui: { pinnedInsertPosition: 'bottom' } })).settings);
    const changed = await observer.waitForEvent((event): event is SettingsChangedMessage => event instanceof SettingsChangedMessage,
      'Readable settings broadcast', { afterIndex });
    check(changed.settings);
    const requestsBefore = fixture.fakeProviders.openAi.requests().length;
    for (const key of GENERATION_UI_SETTING_KEYS) {
      await expect(client.put('/api/v1/app/settings', { ui: { [key]: selections[key] } }))
        .rejects.toMatchObject({ status: 400, body: { errorCode: 'INVALID_REMOTE_SETTINGS' } });
      await expect(client.post('/api/v1/app/generation/test', { target: key, configurationKey: 'unavailable' }))
        .rejects.toMatchObject({ body: { errorCode: 'GENERATION_TEST_FAILED' } });
    }
    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestsBefore);
    await client.updateSettings({ ui: Object.fromEntries(GENERATION_UI_SETTING_KEYS.map((key) => [key, {}])) });
    await fixture.restartGarcon();
    const repaired = await fixture.client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
    for (const key of GENERATION_UI_SETTING_KEYS) {
      expect(repaired.ui[key]).toBeUndefined();
      expect(repaired.uiEffective[key]?.nodeId).toBe('local');
    }
  }, { executionBackend: 'in-process' });
}, 30_000);
