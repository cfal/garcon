import { expect, test } from 'bun:test';
import type { RemoteSettingsSnapshot } from '../../../common/settings.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('node pin mutations preserve concurrent startup recents and unrelated node preferences', async () => {
  await withIntegrationFixture('node-path-preferences', async (fixture) => {
    const { client, directAgents, dirs } = fixture;
    const otherNode = '33333333-3333-4333-8333-333333333333';
    const patch = (nodeId: string, pinnedPaths: string[]) => ({ paths: { byNode: { [nodeId]: { pinnedPaths } } } });
    const initial = await client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
    expect(initial.paths.byNode?.[client.nodeId]).toBeUndefined();
    const chatId = fixture.newChatId();
    const [started] = await Promise.all([
      client.startDirectChat({ chatId, content: 'Synthetic preference update', projectPath: dirs.project, agent: directAgents.openAi }),
      client.put('/api/v1/app/settings', patch(otherNode, ['/other/pin'])),
      client.put('/api/v1/app/settings', patch(client.nodeId, ['/remote/pin'])),
    ]);
    await client.waitForTurnTerminal(chatId, started.turnId);
    const expected = {
      [client.nodeId]: { recentPaths: [dirs.project], pinnedPaths: ['/remote/pin'] },
      [otherNode]: { recentPaths: [], pinnedPaths: ['/other/pin'] },
    };
    expect((await client.get<RemoteSettingsSnapshot>('/api/v1/app/settings')).paths.byNode).toEqual(expected);
    await expect(client.put('/api/v1/app/settings', { paths: { byNode: { [client.nodeId]: { recentPaths: [] } } } })).rejects.toThrow();
    await fixture.restartGarcon();
    expect((await fixture.client.get<RemoteSettingsSnapshot>('/api/v1/app/settings')).paths.byNode).toEqual(expected);
  }, { executionBackend: 'remote-controller-dials' });
}, 60_000);
