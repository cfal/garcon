import { expect, test } from 'bun:test';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GENERATION_UI_SETTING_KEYS, type RemoteSettingsSnapshot } from '../../../common/settings.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { userContents } from '../../support/chat-assertions.js';

test('concurrent executor deletion fences publication while preserving already-saved selections', async () => {
  await withIntegrationFixture('executor-reference-deletion', async (fixture) => {
    const client = fixture.client;
    const agent = fixture.directAgents.openAi;
    const saved = new Map<string, string>();
    for (const key of GENERATION_UI_SETTING_KEYS) {
      const executor = await client.post<{ id: string }>('/api/v1/executors', {
        label: 'Synthetic worker', direction: 'executor-connects',
      });
      const [saving, deleting] = await Promise.allSettled([
        client.updateSettings({ ui: { [key]: {
          executorId: executor.id, agentId: agent.agentId, model: agent.provider.model,
          apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
          modelProtocol: agent.provider.protocol,
        } } }),
        client.delete(`/api/v1/executors/${executor.id}`),
      ]);
      if (saving.status === 'fulfilled') {
        saved.set(key, executor.id);
        if (deleting.status === 'rejected') {
          expect(deleting.reason.status).toBe(409);
          await client.delete(`/api/v1/executors/${executor.id}`);
        }
      } else {
        expect(deleting.status).toBe('fulfilled');
        expect([404, 409]).toContain(saving.reason.status);
      }
    }
    await fixture.crashAndRestartGarcon();
    const executors = await fixture.client.get<{ executors: { id: string }[] }>('/api/v1/executors');
    expect(executors.executors.map((executor) => executor.id)).toEqual(['local']);
    const settings = await fixture.client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
    for (const key of GENERATION_UI_SETTING_KEYS) expect(settings.ui[key]?.executorId).toBe(saved.get(key));
  }, { executionBackend: 'in-process' });
}, 30_000);

test('unknown persisted executors do not prevent chat deletion or handoff to Local', async () => {
  await withIntegrationFixture('unknown-executor-reference-retirement', async (fixture) => {
    const agent = fixture.directAgents.openAi;
    const ids = [fixture.newChatId(), fixture.newChatId(), fixture.newChatId()];
    for (const chatId of ids) {
      const started = await fixture.client.startDirectChat({
        chatId, agent, projectPath: fixture.dirs.project, content: 'Synthetic original input',
      });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      await fixture.client.waitForProcessing(chatId, false);
    }
    const executorId = '44444444-4444-4444-8444-444444444444';
    await fixture.restartGarcon({ beforeStart: async () => {
      const path = join(fixture.dirs.workspace, 'chats.json');
      const registry = JSON.parse(await readFile(path, 'utf8'));
      for (const id of ids) registry.sessions[id].executorId = executorId;
      registry.sessions[ids[0]!].agentSettingsById = {};
      await writeFile(path, JSON.stringify(registry));
    } });
    expect((await fixture.client.listChats()).sessions.map((chat) => chat.executorId)).toEqual([executorId, executorId, executorId]);
    await fixture.client.deleteChat(ids[0]!);
    await fixture.client.deleteChat(ids[1]!);
    const handoff = await fixture.client.handoffDirectChat({
      chatId: ids[2]!, agent, content: 'Synthetic Local handoff', executorId: 'local', projectPath: fixture.dirs.project,
    });
    await fixture.client.waitForTurnTerminal(ids[2]!, handoff.turnId);
    await fixture.restartGarcon();
    const chats = (await fixture.client.listChats()).sessions;
    expect(chats).toHaveLength(1);
    expect(chats[0]?.id).toBe(ids[2]);
    expect(chats[0]?.executorId ?? 'local').toBe('local');
    expect(userContents((await fixture.client.getMessages(ids[2]!)).messages)).toEqual([
      'Synthetic original input', 'Synthetic Local handoff',
    ]);
  }, { executionBackend: 'in-process' });
}, 30_000);

test('executor removal cannot abandon failed controller-ledger deletion', async () => {
  await withIntegrationFixture('executor-deletion-ledger-failure', async (fixture) => {
    const chatId = fixture.newChatId();
    const started = await fixture.client.startDirectChat({
      chatId, agent: fixture.directAgents.openAi, projectPath: fixture.dirs.project,
      content: 'Synthetic deletion failure input',
    });
    await fixture.client.waitForTurnTerminal(chatId, started.turnId);
    await fixture.client.waitForProcessing(chatId, false);
    const executor = await fixture.client.post<{ id: string }>('/api/v1/executors', {
      label: 'Synthetic unavailable worker', direction: 'executor-connects',
    });
    await fixture.restartGarcon({ beforeStart: async () => {
      const path = join(fixture.dirs.workspace, 'chats.json');
      const registry = JSON.parse(await readFile(path, 'utf8'));
      registry.sessions[chatId].executorId = executor.id;
      await writeFile(path, JSON.stringify(registry));
    } });
    const ledgerRoot = join(fixture.dirs.workspace, 'transcript-ledgers');
    const heldRoot = `${ledgerRoot}-held`;
    const journalPath = join(fixture.dirs.workspace, 'agent-ownership-journal.json');
    await rename(ledgerRoot, heldRoot);
    await writeFile(ledgerRoot, 'Synthetic non-directory blocks controller-ledger removal');
    try {
      await fixture.client.deleteChat(chatId);
      expect((JSON.parse(await readFile(journalPath, 'utf8'))).ownershipIntents).toMatchObject([
        { chatId, phase: 'prepared' },
      ]);
      await expect(fixture.client.delete(`/api/v1/executors/${executor.id}`)).rejects.toMatchObject({ status: 409 });
      expect((await stat(join(heldRoot, chatId))).isDirectory()).toBe(true);
    } finally {
      await rm(ledgerRoot);
      await rename(heldRoot, ledgerRoot);
    }
    await fixture.restartGarcon();
    expect(await stat(join(ledgerRoot, chatId)).catch(() => null)).toBeNull();
    await fixture.client.delete(`/api/v1/executors/${executor.id}`);
    await fixture.restartGarcon();
    expect((JSON.parse(await readFile(journalPath, 'utf8'))).ownershipIntents).toEqual([]);
  }, { executionBackend: 'in-process' });
}, 30_000);
