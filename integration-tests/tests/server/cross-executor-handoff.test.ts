import { expect, test } from 'bun:test';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import { waitForPersistedChat } from '../../support/persisted-chat.js';
import type { AgentHandoffCommandRequest, AgentHandoffCommandResponse } from '../../../common/chat-command-contracts.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

for (const backend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`promptless executor handoff persists and retargets project services before any send (${backend})`, async () => {
    await withIntegrationFixture(`immediate-executor-handoff-${backend}`, async (fixture) => {
      const { client, directAgents, dirs, executionDirs } = fixture;
      const agent = directAgents.openAi;
      await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${agent.provider.providerId}`, {});
      await initializeFixtureRepository(executionDirs.project);
      await runFixtureGit(executionDirs.project, 'checkout', '-b', 'destination-branch');
      await writeFile(join(executionDirs.project, 'remote-only.txt'), 'Synthetic remote file');
      const chatId = fixture.newChatId();
      const started = await client.startDirectChat({ executorId: 'local', chatId, projectPath: dirs.project, content: 'Synthetic original prompt', agent });
      await client.waitForTurnTerminal(chatId, started.turnId);
      const before = await client.getChatSnapshot(chatId);
      if (before.transcript.availability !== 'available') throw new Error('Synthetic source transcript is unavailable');
      const request: AgentHandoffCommandRequest = { chatId, clientRequestId: crypto.randomUUID(), handoff: {
        expectedAgentOwnershipEpoch: before.chat.agentOwnershipEpoch,
        target: { executorId: client.executorId, projectPath: executionDirs.project, agentId: agent.agentId,
          model: agent.provider.model, apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId },
      } };
      expect(await rejectionOf(client.post('/api/v1/chats/agent-handoff', { ...request, handoff: {
        ...request.handoff, target: { ...request.handoff.target, projectPath: join(executionDirs.project, 'missing') },
      } }))).toMatchObject({ status: 404, body: { errorCode: 'VALIDATION_FAILED' } });
      expect((await client.getChatSnapshot(chatId)).chat.agentOwnershipEpoch).toBe(before.chat.agentOwnershipEpoch);
      expect(messagesOfType((await client.getMessages(chatId)).messages, 'agent-switch')).toHaveLength(0);
      const moved = await client.post<AgentHandoffCommandResponse>('/api/v1/chats/agent-handoff', request);
      expect(moved.chat).toMatchObject({ executorId: client.executorId, projectPath: executionDirs.project, agentId: agent.agentId, model: agent.provider.model });
      expect(moved).not.toHaveProperty('turnId');
      expect(moved.chat.agentOwnershipEpoch).not.toBe(before.chat.agentOwnershipEpoch);
      expect(await rejectionOf(client.patch('/api/v1/chats/project-path', {
        chatId, projectPath: executionDirs.project, expectedExecutorId: 'local',
        expectedAgentOwnershipEpoch: before.chat.agentOwnershipEpoch,
        expectedProjectPath: before.chat.projectPath,
      }))).toMatchObject({ status: 409, body: { errorCode: 'STALE_CHAT_OWNERSHIP' } });
      for (const [route, patch] of [
        ['model', { model: agent.provider.model }],
        ['execution-settings', { permissionMode: 'default' }],
      ] as const) {
        expect(await rejectionOf(client.patch(`/api/v1/chats/${route}`, {
          chatId, ...patch, expectedAgentOwnershipEpoch: before.chat.agentOwnershipEpoch,
        }))).toMatchObject({ status: 409, body: { errorCode: 'STALE_CHAT_OWNERSHIP' } });
      }
      const persisted = await waitForPersistedChat({ directories: dirs, chatId, select: (chat) => chat,
        timeoutMessage: 'Handoff did not persist' });
      expect(persisted).toMatchObject({ executorId: client.executorId, projectPath: executionDirs.project, agentSessionId: null, nativeSession: null });
      const after = await client.getMessages(chatId);
      expect(after.transcriptViewId).toBe(before.transcript.transcriptViewId);
      expect(userContents(after.messages)).toEqual(['Synthetic original prompt']);
      expect(messagesOfType(after.messages, 'agent-switch')).toHaveLength(1);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
      const target = new URLSearchParams({ chatId, executorId: client.executorId });
      expect(JSON.stringify(await client.get(`/api/v1/files/list?${target}`))).toContain('remote-only.txt');
      expect(await client.get(`/api/v1/git/status?${new URLSearchParams({ executorId: moved.chat.executorId ?? 'local', project: executionDirs.project })}`)).toMatchObject({ branch: 'destination-branch' });
      await fixture.restartGarcon();
      expect((await fixture.client.getChatSnapshot(chatId)).chat).toMatchObject({ executorId: client.executorId, projectPath: executionDirs.project });
      const resumed = await fixture.client.runChat({ chatId, command: 'Synthetic explicit destination prompt', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
      await fixture.client.waitForTurnTerminal(chatId, resumed.turnId);
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual(['Synthetic original prompt', 'Synthetic explicit destination prompt']);
    }, { executionBackend: backend, projectRoots: 'separate' });
  }, 60_000);

  test(`same-agent handoff starts fresh on the destination and can leave a deleted source (${backend})`, async () => {
    await withIntegrationFixture(`cross-executor-handoff-${backend}`, async (fixture) => {
      const client = fixture.client;
      const agent = fixture.directAgents.openAi;
      await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${agent.provider.providerId}`, {});
      const chatId = fixture.newChatId();
      const nativeId = () => waitForPersistedChat({
        directories: fixture.dirs, chatId, select: (chat) => chat.agentSessionId,
        timeoutMessage: 'Native session identity did not persist',
      });
      const local = await client.startDirectChat({ executorId: 'local', chatId, content: 'Synthetic local input', projectPath: fixture.dirs.project, agent });
      await client.waitForTurnTerminal(chatId, local.turnId);
      const localSession = await nativeId();
      const original = await client.getMessages(chatId);
      const remote = await client.handoffDirectChat({
        chatId, agent, content: 'Synthetic remote input', executorId: client.executorId, projectPath: fixture.executionDirs.project,
      });
      await client.waitForTurnTerminal(chatId, remote.turnId);
      expect((await client.listChats()).sessions.find((chat) => chat.id === chatId)).toMatchObject({ executorId: client.executorId, projectPath: fixture.executionDirs.project });
      expect(await nativeId()).not.toBe(localSession);
      expect((await client.getMessages(chatId)).transcriptViewId).toBe(original.transcriptViewId);
      await client.waitForProcessing(chatId, false);
      await client.delete(`/api/v1/executors/${client.executorId}`);
      expect((await client.listChats()).sessions.find((chat) => chat.id === chatId)?.executorId).toBe(client.executorId);
      expect(userContents((await client.getMessages(chatId)).messages)).toEqual(['Synthetic local input', 'Synthetic remote input']);
      const returned = await client.handoffDirectChat({ chatId, agent, content: 'Synthetic return input', executorId: 'local', projectPath: fixture.dirs.project });
      await client.waitForTurnTerminal(chatId, returned.turnId);
      const row = (await client.listChats()).sessions.find((chat) => chat.id === chatId)!;
      expect(row.executorId ?? 'local').toBe('local');
      expect(row.projectPath).toBe(fixture.dirs.project);
      expect(await nativeId()).not.toBe(localSession);
      const messages = (await client.getMessages(chatId)).messages;
      expect(userContents(messages)).toEqual(['Synthetic local input', 'Synthetic remote input', 'Synthetic return input']);
      expect(messagesOfType(messages, 'agent-switch').map((message) => [message.fromExecutorId, message.toExecutorId])).toEqual([
        ['local', client.executorId], [client.executorId, 'local'],
      ]);
      await client.reloadChat(chatId);
      expect(messagesOfType((await client.getMessages(chatId)).messages, 'agent-switch')).toHaveLength(2);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(3);
    }, { executionBackend: backend, projectRoots: 'separate' });
  }, 45_000);
}
