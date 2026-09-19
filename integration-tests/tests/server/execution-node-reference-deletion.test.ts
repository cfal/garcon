import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GENERATION_UI_SETTING_KEYS, type RemoteSettingsSnapshot } from '../../../common/settings.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { userContents } from '../../support/chat-assertions.js';

test('concurrent node deletion and generation selection never persist a dangling reference', async () => {
  await withIntegrationFixture('node-reference-deletion', async (fixture) => {
    const client = fixture.client;
    const agent = fixture.directAgents.openAi;
    for (const key of GENERATION_UI_SETTING_KEYS) {
      const node = await client.post<{ id: string }>('/api/v1/execution-nodes', {
        label: 'Synthetic worker', direction: 'node-connects',
      });
      const [saving, deleting] = await Promise.allSettled([
        client.updateSettings({ ui: { [key]: {
          nodeId: node.id, agentId: agent.agentId, model: agent.provider.model,
          apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
          modelProtocol: agent.provider.protocol,
        } } }),
        client.delete(`/api/v1/execution-nodes/${node.id}`),
      ]);
      expect([saving.status, deleting.status].sort()).toEqual(['fulfilled', 'rejected']);
      if (saving.status === 'fulfilled') {
        expect(deleting).toMatchObject({ status: 'rejected', reason: { status: 409 } });
        await client.updateSettings({ ui: { [key]: {} } });
        await client.delete(`/api/v1/execution-nodes/${node.id}`);
      } else {
        expect([404, 409]).toContain(saving.reason.status);
      }
    }
    await fixture.crashAndRestartGarcon();
    const nodes = await fixture.client.get<{ nodes: { id: string }[] }>('/api/v1/execution-nodes');
    expect(nodes.nodes.map((node) => node.id)).toEqual(['local']);
    const settings = await fixture.client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
    for (const key of GENERATION_UI_SETTING_KEYS) expect(settings.ui[key]?.nodeId).toBeUndefined();
  }, { executionBackend: 'in-process' });
}, 30_000);

test('unknown persisted nodes do not prevent chat deletion or handoff to Local', async () => {
  await withIntegrationFixture('unknown-node-reference-retirement', async (fixture) => {
    const agent = fixture.directAgents.openAi;
    const ids = [fixture.newChatId(), fixture.newChatId(), fixture.newChatId()];
    for (const chatId of ids) {
      const started = await fixture.client.startDirectChat({
        chatId, agent, projectPath: fixture.dirs.project, content: 'Synthetic original input',
      });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      await fixture.client.waitForProcessing(chatId, false);
    }
    const nodeId = '44444444-4444-4444-8444-444444444444';
    await fixture.restartGarcon({ beforeStart: async () => {
      const path = join(fixture.dirs.workspace, 'chats.json');
      const registry = JSON.parse(await readFile(path, 'utf8'));
      for (const id of ids) registry.sessions[id].nodeId = nodeId;
      registry.sessions[ids[0]!].agentSettingsById = {};
      await writeFile(path, JSON.stringify(registry));
    } });
    expect((await fixture.client.listChats()).sessions.map((chat) => chat.nodeId)).toEqual([nodeId, nodeId, nodeId]);
    await fixture.client.deleteChat(ids[0]!);
    await fixture.client.deleteChat(ids[1]!);
    const handoff = await fixture.client.handoffDirectChat({
      chatId: ids[2]!, agent, content: 'Synthetic Local handoff', nodeId: 'local', projectPath: fixture.dirs.project,
    });
    await fixture.client.waitForTurnTerminal(ids[2]!, handoff.turnId);
    await fixture.restartGarcon();
    const chats = (await fixture.client.listChats()).sessions;
    expect(chats).toHaveLength(1);
    expect(chats[0]?.id).toBe(ids[2]);
    expect(chats[0]?.nodeId ?? 'local').toBe('local');
    expect(userContents((await fixture.client.getMessages(ids[2]!)).messages)).toEqual([
      'Synthetic original input', 'Synthetic Local handoff',
    ]);
  }, { executionBackend: 'in-process' });
}, 30_000);
