import { describe, expect, test } from 'bun:test';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatDetailsResponse } from '../../../common/chat-details.js';
import { parseExecutionLocation } from '../../../common/execution-location.js';
import { parseExecutionNodesSnapshot } from '../../../common/execution-nodes.js';
import { isRecord } from '../../../common/json.js';
import type { SlashCommandsResponse } from '../../../common/slash-commands.js';
import { isOwnershipJournal } from '../../../server/chats/agent-ownership-journal-format.js';
import { writeJsonFileAtomic } from '../../../server/lib/json-file-store.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('unavailable execution owners through HTTP', () => {
  for (const destination of ['local-profile', 'remote-node'] as const) {
    test(`keeps saved history readable without falling back from an unavailable ${destination}`, async () => {
      await withIntegrationFixture(`located-native-${destination}`, async (fixture) => {
        const chatId = fixture.newChatId();
        const agent = fixture.directAgents.openAi;
        const started = await fixture.client.startDirectChat({
          chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic saved input',
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        const history = await fixture.client.getMessages(chatId);
        const detailsPath = `/api/v1/chats/details?${new URLSearchParams({ chatId })}`;
        const details = await fixture.client.get<ChatDetailsResponse>(detailsPath);
        expect(details.transcriptSource?.kind).toBe('filesystem-path');
        if (details.transcriptSource?.kind !== 'filesystem-path') throw new Error('Missing synthetic native file');
        const nativePath = details.transcriptSource.value;
        const nativeBefore = await readFile(nativePath, 'utf8');
        let expectedLocation: ReturnType<typeof parseExecutionLocation> = null;

        await fixture.restartGarcon({ beforeStart: async () => {
          const registryPath = join(fixture.dirs.workspace, 'chats.json');
          const registry: unknown = JSON.parse(await readFile(registryPath, 'utf8'));
          if (!isRecord(registry) || !isRecord(registry.sessions) || !isRecord(registry.sessions[chatId])) {
            throw new Error('Invalid synthetic registry');
          }
          const entry = registry.sessions[chatId];
          const original = parseExecutionLocation(entry.executionLocation);
          const nodesPath = join(fixture.dirs.workspace, 'execution-nodes.json');
          const nodes = parseExecutionNodesSnapshot(JSON.parse(await readFile(nodesPath, 'utf8')));
          if (!original || !nodes) throw new Error('Invalid synthetic execution configuration');
          const nodeId = destination === 'remote-node' ? 'synthetic-offline-node' : nodes.localNodeId;
          expectedLocation = {
            nodeId, instanceId: 'synthetic-unavailable-profile',
            workspaceId: destination === 'remote-node' ? 'synthetic-remote-project' : original.workspaceId,
          };
          await writeJsonFileAtomic(nodesPath, {
            ...nodes,
            nodes: destination === 'remote-node' ? [...nodes.nodes, {
              id: nodeId, kind: 'remote', label: 'Synthetic offline node', removedAt: null,
            }] : nodes.nodes,
            instances: [...nodes.instances, {
              nodeId, id: expectedLocation.instanceId, agentId: agent.agentId, label: 'Synthetic profile',
              storageNamespace: `instances/${expectedLocation.instanceId}`, default: false, removedAt: null,
            }],
            workspaces: destination === 'remote-node' ? [...nodes.workspaces, {
              nodeId, id: expectedLocation.workspaceId, projectPath: fixture.dirs.project, removedAt: null,
            }] : nodes.workspaces,
          }, { mode: 0o600 });
          entry.executionLocation = expectedLocation;
          await writeJsonFileAtomic(registryPath, registry, { mode: 0o600 });
        } });

        expect(await fixture.client.getMessages(chatId)).toEqual(history);
        expect(await fixture.client.get<ChatDetailsResponse>(detailsPath)).toMatchObject({
          chatId, agentSessionId: details.agentSessionId, firstMessage: details.firstMessage, transcriptSource: null,
        });
        for (const requestedAgent of [agent.agentId, 'claude']) {
          await expect(fixture.client.get(`/api/v1/commands?${new URLSearchParams({ chatId, agent: requestedAgent })}`))
            .rejects.toMatchObject({ status: 409, body: { errorCode: 'NODE_UNAVAILABLE' } });
        }
        expect(await fixture.client.get<SlashCommandsResponse>(`/api/v1/commands?${new URLSearchParams({
          projectPath: fixture.dirs.project, agent: agent.agentId,
        })}`)).toEqual({ commands: [] });
        await expect(fixture.client.runDirectChat({ chatId, agent, content: 'synthetic forbidden fallback' }))
          .rejects.toMatchObject({ status: 409, body: { errorCode: 'NODE_UNAVAILABLE' } });
        await expect(fixture.client.reloadChat(chatId)).rejects.toMatchObject({
          response: { code: 'NODE_UNAVAILABLE' },
        });
        expect(await fixture.client.getMessages(chatId)).toEqual(history);
        expect(await readFile(nativePath, 'utf8')).toBe(nativeBefore);
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);

        const localChatId = fixture.newChatId();
        const local = await fixture.client.startDirectChat({
          chatId: localChatId, agent, projectPath: fixture.dirs.project, content: 'synthetic unaffected local input',
        });
        await fixture.client.waitForTurnTerminal(localChatId, local.turnId);
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(2);
        await fixture.restartGarcon();
        expect(await fixture.client.getMessages(chatId)).toEqual(history);
        const registry: unknown = JSON.parse(await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'));
        if (!isRecord(registry) || !isRecord(registry.sessions) || !isRecord(registry.sessions[chatId])) {
          throw new Error('Invalid persisted synthetic registry');
        }
        expect(registry.sessions[chatId].executionLocation).toEqual(expectedLocation);

        expect(await fixture.client.deleteChat(chatId)).toMatchObject({ success: true });
        await expect(access(join(fixture.dirs.workspace, 'transcript-ledgers', chatId)))
          .rejects.toMatchObject({ code: 'ENOENT' });
        expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === chatId)).toBeFalse();
        expect(await readFile(nativePath, 'utf8')).toBe(nativeBefore);
        await expect(fixture.client.startDirectChat({
          chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic blocked replacement',
        })).rejects.toMatchObject({ status: 409, body: { errorCode: 'OWNERSHIP_TRANSFER_PENDING' } });
        await fixture.restartGarcon();
        const journal: unknown = JSON.parse(await readFile(join(fixture.dirs.workspace, 'agent-ownership-journal.json'), 'utf8'));
        if (!isOwnershipJournal(journal)) throw new Error('Invalid retained synthetic ownership journal');
        expect(journal.ownershipIntents).toMatchObject([{
          kind: 'delete', chatId, phase: 'registry-removed',
          releaseReferences: [{ executionLocation: expectedLocation, chat: { chatId, agentId: agent.agentId } }],
        }]);
        await expect(fixture.client.startDirectChat({
          chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic blocked replacement after restart',
        })).rejects.toMatchObject({ status: 409, body: { errorCode: 'OWNERSHIP_TRANSFER_PENDING' } });
        expect((await fixture.client.listChats()).sessions.some((chat) => chat.id === chatId)).toBeFalse();
        expect(await readFile(nativePath, 'utf8')).toBe(nativeBefore);
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(2);
      }, { bindAddress: '0.0.0.0', authentication: 'account' });
    }, 30_000);
  }
});
