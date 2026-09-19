import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GENERATION_UI_SETTING_KEYS, type RemoteSettingsSnapshot } from '../../../common/settings.js';
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
