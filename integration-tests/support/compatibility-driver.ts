import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseExecutors, type ExecutorConnection } from '../../common/executors.js';
import type { ModelCatalogResponse } from '../../common/model-catalog.js';
import type { TerminalListResponse } from '../../common/terminal.js';
import { discoverRuntime } from '../../cli/discovery.js';
import { GarconClient } from '../../cli/garcon-client.js';
import { GarconTestClient } from './garcon-client.js';
import { contractWorkflows, terminalRoundTrip } from './compatibility-workflows.js';
import type { CompatibilityCommand, CompatibilityDriverRequest, CompatibilityDriverResult } from './compatibility-contract.js';
import { rejectionOf } from './promise-assertions.js';
import { fixtureAuthToken, prepareFixtureAuth } from './fixture-auth.js';

const input: CompatibilityDriverRequest = JSON.parse(await Bun.stdin.text());
assert.equal(input.version, 1);


async function execute(client: GarconTestClient, command: CompatibilityCommand): Promise<Record<string, unknown>> {
  switch (command.kind) {
    case 'enroll': {
      const created = await client.post<{ id: string } & Partial<ExecutorConnection>>('/api/v1/executors', {
        label: 'Compatibility worker', direction: command.direction, noTls: true,
        ...(command.connectionUrl ? { connectionUrl: command.connectionUrl } : {}),
      });
      await client.patch(`/api/v1/executors/${created.id}`, { allowControllerCli: true });
      return { executorId: created.id, connectionUrl: created.connectionUrl ?? null };
    }
    case 'inventory': {
      const response = await client.get<{ executors: unknown }>('/api/v1/executors');
      const executors = parseExecutors(response.executors);
      assert(executors, 'Invalid executor inventory');
      const selected = executors.find(executor => executor.id === command.executorId);
      assert(selected, 'Missing executor');
      return { ready: selected.availability === 'ready', bulkReady: selected.bulk?.availability === 'ready', instanceId: selected.instanceId };
    }
    case 'catalog': {
      const response = await client.get<ModelCatalogResponse>(`/api/v1/models?executorId=${encodeURIComponent(command.executorId)}`);
      assert(response.executorInstanceId);
      return { instanceId: response.executorInstanceId, agents: response.catalog.agents.map(agent => ({
        id: agent.id, label: agent.label, schemaVersion: agent.defaultSettings.schemaVersion,
        fileMimeTypes: agent.fileAttachmentMimeTypes ?? [],
      })) };
    }
    case 'synthetic-turn': {
      await client.updateSettings({ ui: { chatTitle: { enabled: false } } });
      const chatId = command.chatId ?? String(Date.now() * 1_000 + crypto.getRandomValues(new Uint16Array(1))[0]! % 1_000);
      try {
        const receipt = command.chatId ? await client.runChat({
          chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
          command: 'Synthetic follow-up',
        }) : await client.startChat({
          chatId, origin: 'interactive', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
          agentId: 'compat-primary', projectPath: command.projectPath, model: 'synthetic',
          permissionMode: 'default', thinkingMode: 'none', command: 'Synthetic start',
          agentSettings: { ownerId: 'compat-primary', schemaVersion: command.schemaVersion, values: { mode: 'synthetic' } },
        });
        const terminal = await client.waitForTurnTerminal(chatId, receipt.turnId);
        return { chatId, accepted: true, finished: terminal.type === 'agent-run-finished',
          error: terminal.type === 'agent-run-failed' ? terminal.error : null };
      } catch (error) {
        if (!(error instanceof Error) || !('status' in error)) throw error;
        return { chatId, accepted: false, status: error.status, message: error.message };
      }
    }
    case 'saved-settings': {
      const chat = (await client.listChats()).sessions.find(chat => chat.id === command.chatId);
      assert(chat, 'Missing saved compatibility chat');
      return { settings: chat.agentSettings };
    }
    case 'contract-workflows': return contractWorkflows(client, command);
    case 'terminal-resume': {
      const inventory = await client.get<TerminalListResponse>(`/api/v1/terminals?executorId=${command.executorId}`);
      assert.equal(inventory.terminalRuntimeId, command.terminalRuntimeId);
      assert(inventory.terminals.some(terminal => terminal.terminalId === command.terminalId));
      await terminalRoundTrip(client, command.terminalId, inventory, 'printf "compat-%s\\n" "$COMPATIBILITY_VALUE"\r', 'compat-retained');
      const connection = await discoverRuntime({ configDir: command.workerConfig, runtime: 'executor' });
      assert.notEqual(connection.instanceId, command.previousControllerId);
      const stale = new GarconClient({ ...connection, instanceId: command.previousControllerId });
      const failure = await rejectionOf(stale.getScheduledPrompts());
      assert(failure instanceof Error && 'errorCode' in failure);
      assert.equal(failure.errorCode, 'CLI_CONTROLLER_CHANGED');
      const fresh = new GarconClient(connection);
      await fresh.getScheduledPrompts();
      return { retained: true };
    }
  }
}

async function run(): Promise<Record<string, unknown>> {
  if (input.kind === 'prepare-auth') return prepareFixtureAuth(input.configDir);
  if (input.kind === 'capture-cli-context') {
    const connection = await discoverRuntime({ configDir: input.configDir, runtime: input.runtime });
    await writeFile(input.contextPath, JSON.stringify(connection), { mode: 0o600 });
    return { captured: true };
  }
  if (input.kind === 'check-cli-restart') {
    const previous: Awaited<ReturnType<typeof discoverRuntime>> = JSON.parse(await readFile(input.contextPath, 'utf8'));
    const stale = new GarconClient(previous);
    assert.equal(await stale.verifyRuntime(), false);
    const failure = await rejectionOf(stale.getScheduledPrompts());
    assert(failure instanceof Error && 'status' in failure);
    if (input.runtime === 'executor') {
      assert('errorCode' in failure);
      assert.equal(failure.errorCode, 'CLI_CONTROLLER_CHANGED');
    } else assert.equal(failure.status, 401);
    const current = await discoverRuntime({ configDir: input.configDir, runtime: input.runtime });
    assert.notEqual(current.instanceId, previous.instanceId);
    await new GarconClient(current).getScheduledPrompts();
    return { staleRejected: true, freshSucceeded: true };
  }
  assert.equal(input.kind, 'command');
  const { command } = input;
  // Short-lived driver processes share only their own login cache, avoiding auth rate limits.
  const cacheKey = createHash('sha256').update(JSON.stringify([import.meta.url, input.baseUrl, input.credentials])).digest('hex');
  const authPath = join(homedir(), 'tmp', `compatibility-auth-${cacheKey}`);
  let authToken = await readFile(authPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (authToken === null) {
    authToken = await fixtureAuthToken(input.baseUrl, input.credentials);
    await writeFile(authPath, authToken, { mode: 0o600 });
  }
  const client = await GarconTestClient.connect(input.baseUrl, { authToken,
    executorId: 'executorId' in command ? command.executorId : 'local' });
  try { return await execute(client, command); }
  finally { await client.close(); }
}

const result: CompatibilityDriverResult = { version: 1, result: await run() };
console.log(JSON.stringify(result));
