import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseExecutors, type ExecutorConnection } from '../../common/executors.js';
import type { ModelCatalogResponse } from '../../common/model-catalog.js';
import type { ReadTextResponse, DirectoryEntry } from '../../common/file-contracts.js';
import type { ExecutionGitResults } from '../../common/git-execution.js';
import type { TerminalCreateResponse, TerminalListResponse, TerminalStreamServerMessage } from '../../common/terminal.js';
import { discoverRuntime } from '../../cli/discovery.js';
import { GarconClient } from '../../cli/garcon-client.js';
import { GarconTestClient } from './garcon-client.js';
import { initializeFixtureRepository } from './git-fixture.js';
import { cliEnvironment } from './cli-environment.js';
import type { CompatibilityCommand, CompatibilityDriverRequest, CompatibilityDriverResult } from './compatibility-contract.js';
import { withTimeout } from './deferred.js';
import { rejectionOf } from './promise-assertions.js';
import { fixtureAuthToken, prepareFixtureAuth } from './fixture-auth.js';

const input: CompatibilityDriverRequest = JSON.parse(await Bun.stdin.text());
assert.equal(input.version, 1);

async function terminalRoundTrip(client: GarconTestClient, terminalId: string, inventory: TerminalListResponse, data: string, marker: string): Promise<void> {
  const attachmentId = crypto.randomUUID();
  client.sendTerminal({ type: 'terminal-attach', terminalId, attachmentId,
    attachmentEpoch: inventory.attachmentEpoch, clientId: 'compatibility-driver', afterSequence: 0, intent: 'takeover' });
  await client.waitForEvent((message): message is Extract<TerminalStreamServerMessage, { type: 'terminal-attached' }> =>
    message.type === 'terminal-attached' && message.attachmentId === attachmentId, 'compatibility terminal attach');
  const afterIndex = client.eventRecords().length;
  client.sendTerminal({ type: 'terminal-input', terminalId, attachmentId, data });
  await client.waitForEvent((message): message is Extract<TerminalStreamServerMessage, { type: 'terminal-output' }> => message.type === 'terminal-output'
    && message.attachmentId === attachmentId && message.data.includes(marker), 'compatibility terminal output', { afterIndex });
}

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
        return { chatId, accepted: true, finished: terminal.type === 'agent-run-finished' };
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
    case 'core-workflow': {
      const { executorId, projectPath } = command;
      await client.updateSettings({ ui: { chatTitle: { enabled: false } } });
      if (!existsSync(join(projectPath, '.git'))) await initializeFixtureRepository(projectPath);
      const path = `compat-${crypto.randomUUID()}.txt`;
      await writeFile(join(projectPath, path), 'Synthetic original\n');
      const query = new URLSearchParams({ executorId, projectPath, path });
      const read = await client.get<ReadTextResponse>(`/api/v1/files/text?${query}`);
      assert.equal(read.content, 'Synthetic original\n');
      await client.put(`/api/v1/files/text?${query}`, { content: 'Synthetic replacement\n', expectedRevision: read.revision, conflictResolution: 'reject' });
      assert.equal(await readFile(join(projectPath, path), 'utf8'), 'Synthetic replacement\n');
      const name = `compat-dir-${crypto.randomUUID()}`;
      const directory = await client.post<DirectoryEntry>(`/api/v1/files/directories?${new URLSearchParams({ executorId, path: projectPath })}`, { name });
      assert.equal(directory.path, join(projectPath, name));
      const summary = await client.post<ExecutionGitResults['getQuickSummary']>('/api/v1/git/quick-summary', { executorId, project: projectPath });
      assert.equal(summary.status, 'ready');
      const workbench = await client.post<ExecutionGitResults['getWorkbenchSnapshot']>('/api/v1/git/workbench/snapshot', { executorId, project: projectPath, mode: 'working', context: 3 });
      assert.equal(workbench.status, 'ready');

      for (const artifact of command.cliArtifacts) {
        for (const runtime of ['controller', 'executor'] as const) {
          const configDir = runtime === 'controller' ? command.controllerConfig : command.workerConfig;
          const invoke = async <T>(args: readonly string[]): Promise<T> => {
            const child = Bun.spawn([artifact.bunExecutable, 'cli/main.ts', '--config-dir', configDir, '--runtime', runtime, ...args], {
              cwd: artifact.repoRoot, env: cliEnvironment({ HOME: command.home }), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
            });
            try {
              const [exitCode, stdout, stderr] = await withTimeout(Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
                30_000, () => 'Compatibility CLI timed out');
              assert.equal(exitCode, 0, stderr);
              return JSON.parse(stdout);
            } finally { if (child.exitCode === null) { child.kill(); await child.exited; } }
          };
          const agents = await invoke<{ agents: { id: string }[] }>(['list', 'agents', '--executor', executorId, '--json']);
          assert(agents.agents.some((agent: { id: string }) => agent.id === 'shell'));
          const started = await invoke<{ receipt: { chatId: string } }>(['start', '--agent', 'shell', '--model', 'sh', '--executor', executorId, '--cwd', projectPath, '--json', "printf 'Synthetic compatibility output\\n'"]);
          const chatId = started.receipt.chatId;
          assert.equal(typeof chatId, 'string');
          await client.waitForProcessing(chatId, false);
          const messages = (await client.getMessages(chatId)).messages.map(row => row.message);
          assert(messages.some(message => message.type === 'command-output' && message.content === 'Synthetic compatibility output\n'),
            'Missing rendered row from the execution worker');
          const definition = { schedule: { type: 'once', runAtUtc: '2099-01-01T09:00:00.000Z' },
            target: { type: 'existing-chat', chatId, busyBehavior: 'skip' }, prompt: 'Synthetic scheduled note' };
          const created = await invoke<{ scheduledPrompt: { id: string }; revision: number }>(['schedule', 'create', '--definition', JSON.stringify(definition), '--json']);
          await invoke(['schedule', 'show', created.scheduledPrompt.id, '--json']);
          await invoke(['schedule', 'delete', created.scheduledPrompt.id, '--expected-revision', String(created.revision), '--json']);
        }
      }
      const inventory = await client.get<TerminalListResponse>(`/api/v1/terminals?executorId=${executorId}`);
      const { terminal } = await client.post<TerminalCreateResponse>('/api/v1/terminals', { executorId,
        expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: crypto.randomUUID(), requestedInitialWorkingDirectory: projectPath });
      await terminalRoundTrip(client, terminal.terminalId, inventory,
        "stty -echo; export COMPATIBILITY_VALUE=retained; printf 'compat-%s\\n' ready\r", 'compat-ready');
      const context = await discoverRuntime({ configDir: command.workerConfig, runtime: 'executor' });
      return { terminalId: terminal.terminalId, terminalRuntimeId: inventory.terminalRuntimeId, controllerId: context.instanceId,
        checked: ['files', 'mkdir', 'git-primary', 'git-bulk', 'cli-direct', 'cli-gateway', 'execution', 'rendered-rows', 'schedules', 'terminals'] };
    }
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
