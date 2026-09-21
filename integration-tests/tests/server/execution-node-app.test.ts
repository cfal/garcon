import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExecutionNodes, type ExecutionNodeConnection } from '../../../common/execution-nodes.js';
import { ExecutionNodesChangedMessage } from '../../../common/ws-events.js';
import { ExecutionNodeProcess } from '../../support/execution-backend.js';
import { withIntegrationFixture, type IntegrationDirectories } from '../../support/integration-fixture.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import { userContents } from '../../support/chat-assertions.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function directories(root: string): Promise<IntegrationDirectories> {
  const dirs = { root, config: join(root, 'config'), workspace: join(root, 'workspace'), project: join(root, 'project'), home: join(root, 'home') };
  for (const directory of Object.values(dirs)) await mkdir(directory, { recursive: true });
  return dirs;
}

async function nodeSnapshots(client: GarconTestClient) {
  const response = await client.get<{ nodes: unknown }>('/api/v1/execution-nodes');
  const nodes = parseExecutionNodes(response.nodes);
  if (!nodes) throw new Error('Invalid execution node snapshot');
  return nodes;
}

async function waitReady(client: GarconTestClient, id: string): Promise<void> {
  const afterIndex = client.markEvents();
  if ((await nodeSnapshots(client)).some((node) => node.id === id && node.availability === 'ready')) return;
  await client.waitForEvent(
    (message): message is ExecutionNodesChangedMessage => message instanceof ExecutionNodesChangedMessage
      && message.nodes.some((node) => node.id === id && node.availability === 'ready'),
    'Execution node ready', { afterIndex, timeoutMs: 20_000 },
  );
}

test('node onboarding is available offline and keeps credentials out of public snapshots', async () => {
  await withIntegrationFixture('execution-node-offline-onboarding', async (fixture) => {
    const client = fixture.client;
    expect(await nodeSnapshots(client)).toMatchObject([{ id: 'local', availability: 'ready' }]);
    const created = await client.post<ExecutionNodeConnection & { id: string }>('/api/v1/execution-nodes', {
      label: 'Waiting worker', direction: 'node-connects',
    });
    const descriptor = new URL(created.connectionUrl);
    expect(descriptor.hostname).toBe('example.com');
    expect(descriptor.pathname).toBe(`/execution-node/${created.id}`);
    const secret = new URLSearchParams(descriptor.hash.slice(1)).get('secret')!;
    expect(secret).toHaveLength(43);
    const nodes = await nodeSnapshots(client);
    expect(nodes[1]).toMatchObject({ id: created.id, availability: 'offline', projectBasePath: null });
    expect(JSON.stringify(nodes)).not.toContain(secret);
    const reveal = await fetch(`${fixture.garcon.baseUrl}/api/v1/execution-nodes/${created.id}/connection`);
    expect(reveal.headers.get('cache-control')).toBe('no-store');
    expect(await reveal.json()).toEqual({ connectionUrl: created.connectionUrl, allowInsecureDevelopment: false, allowUnverifiedTls: false });
    await expect(client.get(`/api/v1/models?nodeId=${created.id}`)).rejects.toMatchObject({ status: 503 });
    await expect(client.delete('/api/v1/execution-nodes/local')).rejects.toMatchObject({
      status: 404, body: { errorCode: 'EXECUTION_NODE_NOT_FOUND' },
    });
    await client.patch(`/api/v1/execution-nodes/${created.id}`, { label: 'Renamed', enabled: false });
    expect((await nodeSnapshots(client))[1]).toMatchObject({ label: 'Renamed', enabled: false });
    await client.delete(`/api/v1/execution-nodes/${created.id}`);
    expect(await nodeSnapshots(client)).toHaveLength(1);
  }, { executionBackend: 'in-process' });
}, 30_000);

test('Local and two public workers coexist, reject remote machine IO, and retain offline chats after restart', async () => {
  await withIntegrationFixture('execution-node-app', async (fixture) => {
    const workers: ExecutionNodeProcess[] = [];
    try {
      const client = fixture.client;
      const a = await directories(join(fixture.dirs.root, 'worker-a'));
      const b = await directories(join(fixture.dirs.root, 'worker-b'));
      const inbound = await client.post<ExecutionNodeConnection & { id: string }>('/api/v1/execution-nodes', {
        label: 'Inbound', direction: 'node-connects', allowInsecureDevelopment: true,
      });
      const inboundUrl = new URL(inbound.connectionUrl);
      inboundUrl.protocol = 'ws:';
      inboundUrl.host = new URL(fixture.garcon.baseUrl).host;
      const workerA = await ExecutionNodeProcess.start({
        repoRoot, directories: a, environment: {}, connection: { kind: 'dial', url: inboundUrl.href },
      });
      workers.push(workerA);
      await waitReady(client, inbound.id);
      const workerB = await ExecutionNodeProcess.start({
        repoRoot, directories: b, environment: {}, connection: { kind: 'listen', port: 0, bindAddress: '127.0.0.1' },
      });
      workers.push(workerB);
      expect(new URL(await workerB.listening()).hostname).toBe('127.0.0.1');
      const outboundUrl = new URL(await workerB.connectionUrl());
      outboundUrl.hostname = '127.0.0.1';
      const outbound = await client.post<ExecutionNodeConnection & { id: string }>('/api/v1/execution-nodes', {
        label: 'Outbound', direction: 'controller-connects', connectionUrl: outboundUrl.href, allowInsecureDevelopment: true,
      });
      await waitReady(client, outbound.id);
      expect((await nodeSnapshots(client)).map((node) => node.availability)).toEqual(['ready', 'ready', 'ready']);

      const agent = fixture.directAgents.openAi;
      const chatA = fixture.newChatId();
      const chatB = fixture.newChatId();
      const localChat = fixture.newChatId();
      const startedA = await client.startDirectChat({ nodeId: inbound.id, chatId: chatA, projectPath: a.project, agent, content: 'Synthetic input A' });
      await client.waitForTurnTerminal(chatA, startedA.turnId);
      await client.waitForProcessing(chatA, false);
      const held = fixture.fakeProviders.openAi.holdNext({ model: agent.provider.model });
      const startedB = await client.startDirectChat({ nodeId: outbound.id, chatId: chatB, projectPath: b.project, agent, content: 'Synthetic input B' });
      await held.received;
      await expect(client.patch(`/api/v1/execution-nodes/${outbound.id}`, { enabled: false })).rejects.toMatchObject({ status: 409 });
      await client.patch(`/api/v1/execution-nodes/${outbound.id}`, { label: 'Running worker' });
      await client.patch(`/api/v1/execution-nodes/${inbound.id}`, { enabled: false });
      expect((await nodeSnapshots(client)).find((node) => node.id === outbound.id)?.availability).toBe('ready');
      const local = await client.startDirectChat({ nodeId: 'local', chatId: localChat, projectPath: fixture.dirs.project, agent, content: 'Synthetic local input' });
      await client.waitForTurnTerminal(localChat, local.turnId);
      held.releaseText('Synthetic answer B');
      await client.waitForTurnTerminal(chatB, startedB.turnId);
      await expect(client.delete(`/api/v1/execution-nodes/${inbound.id}`)).rejects.toMatchObject({ status: 409 });

      const localFile = join(fixture.dirs.project, 'input.txt');
      await writeFile(localFile, 'Controller content');
      const blocked = await fetch(`${fixture.garcon.baseUrl}/api/v1/files/text?projectPath=${encodeURIComponent(fixture.dirs.project)}&path=input.txt`, {
        method: 'PUT', headers: { 'Content-Type': 'Application/JSON' },
        body: JSON.stringify({ nodeId: outbound.id, content: 'Do not write', expectedRevision: 'v1:synthetic', conflictResolution: 'overwrite' }),
      });
      expect(blocked.status).toBe(400);
      expect(await readFile(localFile, 'utf8')).toBe('Controller content');

      await client.updateSettings({ ui: { promptRefinement: {
        nodeId: inbound.id, agentId: agent.agentId, model: agent.provider.model,
        apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
        modelProtocol: agent.provider.protocol, thinkingMode: 'none',
      } } });
      const requestCount = fixture.fakeProviders.openAi.requests().length;
      await expect(client.refinePrompt({ draft: 'Synthetic draft', target: 'prompt' })).rejects.toBeDefined();
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount);

      for (const worker of workers) await worker.stop();
      workers.length = 0;
      await fixture.crashAndRestartGarcon();
      expect((await nodeSnapshots(fixture.client)).map((node) => node.availability)).toEqual(['ready', 'offline', 'offline']);
      const chats = (await fixture.client.listChats()).sessions;
      expect(chats.find((chat) => chat.id === chatA)).toMatchObject({ nodeId: inbound.id, projectPath: a.project });
      expect(chats.find((chat) => chat.id === chatB)).toMatchObject({ nodeId: outbound.id, projectPath: b.project });
      expect(userContents((await fixture.client.getMessages(chatA)).messages)).toEqual(['Synthetic input A']);
      expect(userContents((await fixture.client.getMessages(chatB)).messages)).toEqual(['Synthetic input B']);
    } finally {
      for (const worker of workers.reverse()) await worker.stop();
    }
  }, { executionBackend: 'in-process' });
}, 60_000);
