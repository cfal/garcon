import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID } from '../../../common/agents.js';
import type { ChatDetailsResponse } from '../../../common/chat-details.js';
import { parseExecutionNodesSnapshot, type ExecutionNodesSnapshot } from '../../../common/execution-nodes.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

async function readTopology(workspace: string): Promise<ExecutionNodesSnapshot> {
  const snapshot = parseExecutionNodesSnapshot(JSON.parse(await readFile(join(workspace, 'execution-nodes.json'), 'utf8')));
  if (!snapshot) throw new Error('Invalid fixture topology');
  return snapshot;
}

test('an isolated default cannot execute through the legacy provider host on ordinary startup', async () => {
  const agentId = DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID;
  const isolatedId = 'synthetic-isolated-default';
  await withIntegrationFixture('standalone-isolated-default', async (fixture) => {
    const chatId = fixture.newChatId();
    await expect(fixture.client.startDirectChat({
      chatId, agent: fixture.directAgents.openAi, projectPath: fixture.dirs.project, content: 'synthetic isolated input',
    })).rejects.toMatchObject({ status: 409, body: { errorCode: 'NODE_UNAVAILABLE', retryable: false } });
    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(0);
    expect((await fixture.client.listChats()).sessions.map((chat) => chat.id)).not.toContain(chatId);
    expect(existsSync(join(fixture.dirs.workspace, 'agent-data', agentId))).toBe(false);
    expect(existsSync(join(fixture.dirs.workspace, 'agent-data', 'instances', isolatedId))).toBe(false);
    const configured = await readTopology(fixture.dirs.workspace);
    expect(configured.instances.filter((instance) => instance.agentId === agentId)).toEqual([{
      id: isolatedId, nodeId: configured.localNodeId, agentId, label: 'Synthetic isolated default',
      storageNamespace: `instances/${isolatedId}`, default: true, removedAt: null,
    }]);
    const localId = fixture.newChatId();
    const turn = await fixture.client.startDirectChat({
      chatId: localId, agent: fixture.directAgents.anthropic, projectPath: fixture.dirs.project, content: 'synthetic available input',
    });
    expect((await fixture.client.waitForTurnTerminal(localId, turn.turnId)).type).toBe('agent-run-finished');
  }, {
    bindAddress: '0.0.0.0',
    async prepareWorkspace(dirs) {
      const configured: ExecutionNodesSnapshot = {
        version: 1, localNodeId: 'synthetic-local-node',
        nodes: [{ id: 'synthetic-local-node', kind: 'local', label: 'Synthetic local', removedAt: null }],
        instances: [{
          id: isolatedId, nodeId: 'synthetic-local-node', agentId, label: 'Synthetic isolated default',
          storageNamespace: `instances/${isolatedId}`, default: true, removedAt: null,
        }],
        workspaces: [],
      };
      await writeFile(join(dirs.workspace, 'execution-nodes.json'), JSON.stringify(configured));
    },
  });
}, 30_000);

test('a removed unrelated default preserves controller history and ordinary local resume', async () => {
  await withIntegrationFixture('standalone-removed-default', async (fixture) => {
    const chatId = fixture.newChatId();
    const agent = fixture.directAgents.openAi;
    const first = await fixture.client.startDirectChat({
      chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic retained input',
    });
    expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type).toBe('agent-run-finished');
    const before = await fixture.client.getMessages(chatId);
    const original = await readTopology(fixture.dirs.workspace);
    const removed = original.instances.find((instance) => instance.agentId === 'codex' && instance.default)!;
    expect(removed).toBeDefined();
    const tombstone = { ...removed, removedAt: '2026-09-10T00:00:00.000Z' };
    await fixture.restartGarcon({
      async beforeStart() {
        await writeFile(join(fixture.dirs.workspace, 'execution-nodes.json'), JSON.stringify({
          ...original, instances: original.instances.map((instance) => instance.id === removed.id ? tombstone : instance),
        }));
      },
    });
    expect((await fixture.client.listChats()).sessions.map((chat) => chat.id)).toContain(chatId);
    expect((await fixture.client.getMessages(chatId)).messages).toEqual(before.messages);
    const restarted = await readTopology(fixture.dirs.workspace);
    expect(restarted.instances.filter((instance) => instance.agentId === 'codex')).toEqual([tombstone]);
    const resumed = await fixture.client.runDirectChat({ chatId, agent, content: 'synthetic resumed input' });
    expect((await fixture.client.waitForTurnTerminal(chatId, resumed.turnId)).type).toBe('agent-run-finished');
    expect(fixture.fakeProviders.openAi.requests().at(-1)?.body.messages.map((message) => message.content)).toEqual([
      'synthetic retained input', 'echo:synthetic retained input', 'synthetic resumed input',
    ]);
  }, { bindAddress: '0.0.0.0' });
}, 30_000);

test('an existing agent-data symlink preserves Direct native resume after restart', async () => {
  await withIntegrationFixture('standalone-symlink-storage', async (fixture) => {
    const chatId = fixture.newChatId();
    const agent = fixture.directAgents.openAi;
    const first = await fixture.client.startDirectChat({
      chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic source input',
    });
    expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type).toBe('agent-run-finished');
    const before = await fixture.client.get<ChatDetailsResponse>(`/api/v1/chats/details?chatId=${chatId}`);
    const moved = join(fixture.dirs.root, 'relocated-agent-data');
    await fixture.restartGarcon({
      async beforeStart() {
        const original = join(fixture.dirs.workspace, 'agent-data');
        await rename(original, moved);
        await symlink(moved, original);
      },
    });
    const resumed = await fixture.client.runDirectChat({ chatId, agent, content: 'synthetic resumed input' });
    expect((await fixture.client.waitForTurnTerminal(chatId, resumed.turnId)).type).toBe('agent-run-finished');
    const after = await fixture.client.get<ChatDetailsResponse>(`/api/v1/chats/details?chatId=${chatId}`);
    expect(after.agentSessionId).toBe(before.agentSessionId);
    expect(await realpath(after.transcriptSource!.value)).toBe(await realpath(before.transcriptSource!.value));
    expect(await realpath(after.transcriptSource!.value)).toStartWith(moved + '/');
    expect(fixture.fakeProviders.openAi.requests().at(-1)?.body.messages.map((message) => message.content)).toEqual([
      'synthetic source input', 'echo:synthetic source input', 'synthetic resumed input',
    ]);
  }, { bindAddress: '0.0.0.0' });
}, 30_000);
