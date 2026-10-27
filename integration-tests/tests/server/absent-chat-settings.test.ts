import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import type { ChatRegistrySnapshot } from '../../../server/controller/chats/registry-contracts.js';

test('runs and edits unrelated settings with current defaults without persisting absent envelopes', async () => {
  await withIntegrationFixture('absent-chat-settings', async (fixture) => {
    const chatId = fixture.newChatId();
    const started = await fixture.client.startDirectChat({
      chatId,
      agent: fixture.directAgents.openAi,
      projectPath: fixture.executionDirs.project,
      content: 'Generic initial input',
    });
    expect((await fixture.client.waitForTurnTerminal(chatId, started.turnId)).type).toBe('agent-run-finished');
    await fixture.client.waitForProcessing(chatId, false);

    const registryPath = join(fixture.dirs.workspace, 'chats.json');
    await fixture.restartGarcon({ beforeStart: async () => {
      const registry: ChatRegistrySnapshot = JSON.parse(await readFile(registryPath, 'utf8'));
      registry.sessions[chatId]!.agentSettingsById = {};
      await writeFile(registryPath, JSON.stringify(registry));
    } });
    const chat = (await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)!;
    expect(chat.agentSettings).toBeNull();
    const patched = await fixture.client.patch<{ agentSettings: unknown }>('/api/v1/chats/execution-settings', {
      chatId, permissionMode: 'default',
    });
    expect(patched.agentSettings).toBeNull();
    await fixture.client.patch('/api/v1/chats/model', { chatId, model: chat.model });
    const edited: ChatRegistrySnapshot = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(edited.sessions[chatId]!.agentSettingsById).toEqual({});

    const resumed = await fixture.client.runChat({
      chatId,
      command: 'Generic follow-up input',
      clientRequestId: crypto.randomUUID(),
      clientMessageId: crypto.randomUUID(),
    });
    expect((await fixture.client.waitForTurnTerminal(chatId, resumed.turnId)).type).toBe('agent-run-finished');
    await fixture.client.waitForProcessing(chatId, false);

    await fixture.restartGarcon();
    const persisted: ChatRegistrySnapshot = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(persisted.sessions[chatId]!.agentSettingsById).toEqual({});
    expect((await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)?.agentSettings).toBeNull();
  });
}, 60_000);
