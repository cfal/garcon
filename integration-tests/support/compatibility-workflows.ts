import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_CONTRACT_HEADER, CLI_OPERATIONS, type CliOperation } from '../../common/cli-contracts.js';
import { EXECUTION_WORKFLOW_V1, RPC_V1, type ExecutorOperation } from '../../common/executor-contracts.js';
import { parseExecutors } from '../../common/executors.js';
import type { DirectoryEntry, ReadTextResponse } from '../../common/file-contracts.js';
import type { ExecutionFileEntry } from '../../server-agents/interface/src/index.js';
import type { ExecutionGitResults } from '../../common/git-execution.js';
import type { HttpErrorResponse } from '../../common/http-error.js';
import type { TerminalCreateResponse, TerminalListResponse, TerminalStreamServerMessage } from '../../common/terminal.js';
import { discoverRuntime, type RuntimeConnection } from '../../cli/discovery.js';
import { cliEnvironment } from './cli-environment.js';
import type { CompatibilityCommand, ContractProbe } from './compatibility-contract.js';
import { CompatibilityEvidence } from './compatibility-evidence.js';
import { withTimeout } from './deferred.js';
import { GarconApiError, type GarconTestClient } from './garcon-client.js';
import { initializeFixtureRepository } from './git-fixture.js';
import { rejectionOf } from './promise-assertions.js';
import type { SourceArtifact } from './source-artifact.js';

type WorkflowCommand = Extract<CompatibilityCommand, { kind: 'contract-workflows' }>;

function executorRequirements(...names: readonly ExecutorOperation[]): ContractProbe[] {
  return [...new Set(names)].map(name => ({ surface: 'executor', name, version: RPC_V1[name].version }));
}

function cliRequirements(surface: 'direct-cli' | 'gateway-cli', ...operations: readonly CliOperation[]): ContractProbe[] {
  const refs = operations.flatMap(operation => [CLI_OPERATIONS[operation][1], ...CLI_OPERATIONS[operation][1].requires]);
  return [...new Map(refs.map(ref => [`${ref.name}@${ref.version}`, { surface, name: ref.name, version: ref.version }])).values()];
}

async function refused(action: () => Promise<unknown>): Promise<void> {
  const error = await rejectionOf(action());
  assert(error instanceof GarconApiError, 'Expected an HTTP refusal');
  assert.equal((error.body as HttpErrorResponse).errorCode, 'OPERATION_UNSUPPORTED');
  assert.equal((error.body as HttpErrorResponse).retryable, false);
}

async function refusedCli(connection: RuntimeConnection, missing: readonly ContractProbe[]): Promise<void> {
  for (const ref of missing) {
    const operation = Object.entries(CLI_OPERATIONS).find(([, versions]) => versions[1].name === ref.name)?.[0];
    assert(operation, `No refusal probe for ${ref.name}`);
    const [method, path] = operation.split(' ');
    assert(!path!.includes(':'), 'Parameterized refusal probes need a captured resource');
    const response = await fetch(`${connection.baseUrl}${path}`, { method, headers: {
      authorization: `Bearer ${connection.localCapability}`, 'X-Garcon-Server-Instance': connection.instanceId,
      [CLI_CONTRACT_HEADER]: `${ref.name}@${ref.version}`,
    } });
    const body = await response.json() as HttpErrorResponse;
    assert.equal(response.status, 422);
    assert.equal(body.errorCode, 'OPERATION_UNSUPPORTED');
    assert.equal(body.retryable, false);
  }
}

async function invokeCli<T>(artifact: SourceArtifact, command: WorkflowCommand, runtime: 'controller' | 'executor', args: readonly string[]): Promise<T> {
  const configDir = runtime === 'controller' ? command.controllerConfig : command.workerConfig;
  const child = Bun.spawn([artifact.bunExecutable, 'cli/main.ts', '--config-dir', configDir, '--runtime', runtime, ...args], {
    cwd: artifact.repoRoot, env: cliEnvironment({ HOME: command.home }), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const [exitCode, stdout, stderr] = await withTimeout(Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
      30_000, () => 'Compatibility CLI timed out');
    assert.equal(exitCode, 0, stderr);
    return JSON.parse(stdout);
  } finally { if (child.exitCode === null) { child.kill(); await child.exited; } }
}

export async function terminalRoundTrip(client: GarconTestClient, terminalId: string, inventory: TerminalListResponse, data: string, marker: string): Promise<void> {
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

export async function contractWorkflows(client: GarconTestClient, command: WorkflowCommand): Promise<Record<string, unknown>> {
  const { executorId, projectPath } = command;
  const response = await client.get<{ executors: unknown }>('/api/v1/executors');
  const selected = parseExecutors(response.executors)?.find(executor => executor.id === executorId);
  assert(selected?.availability === 'ready', 'Missing ready executor');
  const direct = await discoverRuntime({ configDir: command.controllerConfig, runtime: 'controller' });
  const gateway = await discoverRuntime({ configDir: command.workerConfig, runtime: 'executor' });
  assert.equal(direct.instanceId, gateway.instanceId);
  // Snapshots expose usable operations, not the private negotiated profile or resource codecs.
  const executor = Object.fromEntries(Object.values(RPC_V1).filter(definition => selected.operations.includes(definition.name))
    .map(definition => [definition.name, [definition.version]]));
  const evidence = new CompatibilityEvidence({ executor, 'direct-cli': direct.protocol.contracts,
    'gateway-cli': gateway.protocol.contracts }, command.expectedUnsupported);
  await client.updateSettings({ ui: { chatTitle: { enabled: false } } });
  if (!existsSync(join(projectPath, '.git'))) await initializeFixtureRepository(projectPath);
  const path = `compat-${crypto.randomUUID()}.txt`;
  await writeFile(join(projectPath, path), 'Synthetic original\n');
  const query = new URLSearchParams({ executorId, projectPath, path });
  const read = () => client.get<ReadTextResponse>(`/api/v1/files/text?${query}`);
  let expectedRevision = 'v1:synthetic-revision';
  await evidence.check('files-read', executorRequirements('projects.inspect', 'files.read'), async () => {
    const result = await read();
    assert.equal(result.content, 'Synthetic original\n');
    expectedRevision = result.revision;
  }, () => refused(read));
  const save = () => client.put(`/api/v1/files/text?${query}`, {
    content: 'Synthetic replacement\n', expectedRevision, conflictResolution: 'overwrite',
  });
  await evidence.check('files-save', executorRequirements('projects.inspect', 'files.save'), async () => {
    await save();
    assert.equal(await readFile(join(projectPath, path), 'utf8'), 'Synthetic replacement\n');
  }, async () => { await refused(save); assert.equal(await readFile(join(projectPath, path), 'utf8'), 'Synthetic original\n'); });
  const list = () => client.get<ExecutionFileEntry[]>(`/api/v1/files/list?${query}`);
  await evidence.check('files-list', executorRequirements('projects.inspect', 'files.list'), async () => {
    assert((await list()).some(entry => entry.relativePath === path));
  }, () => refused(list));
  const name = `compat-dir-${crypto.randomUUID()}`;
  const mkdir = () => client.post<DirectoryEntry>(`/api/v1/files/directories?${new URLSearchParams({ executorId, path: projectPath })}`, { name });
  await evidence.check('mkdir', executorRequirements('files.createDirectory'), async () => {
    assert.equal((await mkdir()).path, join(projectPath, name));
  }, async () => { await refused(mkdir); assert(!existsSync(join(projectPath, name))); });
  const summary = () => client.post<ExecutionGitResults['getQuickSummary']>('/api/v1/git/quick-summary', { executorId, project: projectPath });
  await evidence.check('git-primary', executorRequirements('git.getQuickSummary'), async () => {
    assert.equal((await summary()).status, 'ready');
  }, () => refused(summary));
  const workbench = () => client.post<ExecutionGitResults['getWorkbenchSnapshot']>('/api/v1/git/workbench/snapshot', { executorId, project: projectPath, mode: 'working', context: 3 });
  await evidence.check('git-bulk', executorRequirements('git.getWorkbenchSnapshot'), async () => {
    assert.equal((await workbench()).status, 'ready');
  }, () => refused(workbench));

  for (const [runtime, surface, connection] of [['controller', 'direct-cli', direct], ['executor', 'gateway-cli', gateway]] as const) {
    const suffix = runtime === 'controller' ? 'direct' : 'gateway';
    const catalog = () => client.get(`/api/v1/models?executorId=${executorId}`);
    const refusal = async (missing: readonly ContractProbe[]) => {
      const cli = missing.filter(ref => ref.surface === surface);
      if (cli.length) await refusedCli(connection, cli);
      if (missing.some(ref => ref.surface === 'executor')) await refused(catalog);
    };
    await evidence.check(`cli-${suffix}`, [...cliRequirements(surface, 'GET /api/v1/models'), ...executorRequirements('catalog.snapshot')], async () => {
      for (const artifact of command.cliArtifacts) {
        const agents = await invokeCli<{ agents: { id: string }[] }>(artifact, command, runtime, ['list', 'agents', '--executor', executorId, '--json']);
        assert(agents.agents.some(agent => agent.id === 'shell'));
      }
    }, refusal);
    const marker = `compat-execution-${crypto.randomUUID()}`;
    const start = () => client.startChat({
      chatId: String(Date.now() * 1_000), executorId, origin: 'interactive', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
      agentId: 'shell', projectPath, model: 'sh', permissionMode: 'default', thinkingMode: 'none',
      agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, command: `touch ${join(projectPath, marker)}`,
    });
    await evidence.check(`execution-${suffix}`, [
      ...executorRequirements(...EXECUTION_WORKFLOW_V1.map(definition => definition.name), 'execution.start'),
      ...cliRequirements(surface, 'GET /api/v1/models', 'GET /api/v1/app/settings', 'GET /api/v1/preambles', 'POST /api/v1/chats/start'),
    ], async () => {
      for (const artifact of command.cliArtifacts) {
        const started = await invokeCli<{ receipt: { chatId: string } }>(artifact, command, runtime,
          ['start', '--agent', 'shell', '--model', 'sh', '--executor', executorId, '--cwd', projectPath, '--json', "printf 'Synthetic compatibility output\\n'"]);
        const chatId = started.receipt.chatId;
        assert.equal(typeof chatId, 'string');
        await client.waitForProcessing(chatId, false);
        const messages = (await client.getMessages(chatId)).messages.map(row => row.message);
        assert(messages.some(message => message.type === 'command-output' && message.content === 'Synthetic compatibility output\n'),
          'Missing rendered row from the execution worker');
      }
    }, async missing => {
      const cli = missing.filter(ref => ref.surface === surface);
      if (cli.length) await refusedCli(connection, cli);
      if (missing.some(ref => ref.surface === 'executor')) { await refused(start); assert(!existsSync(join(projectPath, marker))); }
    });
    await evidence.check(`schedules-${suffix}`, cliRequirements(surface,
      'POST /api/v1/scheduled-prompts', 'GET /api/v1/scheduled-prompts', 'DELETE /api/v1/scheduled-prompts'), async () => {
      for (const artifact of command.cliArtifacts) {
        const definition = { schedule: { type: 'once', runAtUtc: '2099-01-01T09:00:00.000Z' },
          target: { type: 'new-chat', executorId, agentId: 'shell', projectPath, model: 'sh', apiProviderId: null, modelEndpointId: null,
            modelProtocol: null, permissionMode: 'default', thinkingMode: 'none',
            agentSettingsById: { shell: { ownerId: 'shell', schemaVersion: 1, values: {} } }, tags: [], preambleChoice: { mode: 'defaults' } },
          prompt: 'Synthetic scheduled note' };
        const created = await invokeCli<{ scheduledPrompt: { id: string }; revision: number }>(artifact, command, runtime,
          ['schedule', 'create', '--definition', JSON.stringify(definition), '--json']);
        await invokeCli(artifact, command, runtime, ['schedule', 'show', created.scheduledPrompt.id, '--json']);
        await invokeCli(artifact, command, runtime, ['schedule', 'delete', created.scheduledPrompt.id, '--expected-revision', String(created.revision), '--json']);
      }
    }, missing => refusedCli(connection, missing));
  }

  let retainedTerminal: { terminalId: string; terminalRuntimeId: string } | null = null;
  await evidence.check('terminals', executorRequirements('terminals.list', 'terminals.create', 'terminals.attach', 'terminals.input', 'terminals.detach'), async () => {
    const inventory = await client.get<TerminalListResponse>(`/api/v1/terminals?executorId=${executorId}`);
    assert(inventory.terminalRuntimeId, 'Missing terminal runtime identity');
    const { terminal } = await client.post<TerminalCreateResponse>('/api/v1/terminals', { executorId,
      expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: crypto.randomUUID(), requestedInitialWorkingDirectory: projectPath });
    await terminalRoundTrip(client, terminal.terminalId, inventory,
      "stty -echo; export COMPATIBILITY_VALUE=retained; printf 'compat-%s\\n' ready\r", 'compat-ready');
    retainedTerminal = { terminalId: terminal.terminalId, terminalRuntimeId: inventory.terminalRuntimeId };
  }, async missing => {
    if (missing.some(ref => ref.name === 'terminals.list')) await refused(() => client.get(`/api/v1/terminals?executorId=${executorId}`));
    else {
      const inventory = await client.get<TerminalListResponse>(`/api/v1/terminals?executorId=${executorId}`);
      await refused(() => client.post('/api/v1/terminals', { executorId, expectedTerminalRuntimeId: inventory.terminalRuntimeId,
        requestId: crypto.randomUUID(), requestedInitialWorkingDirectory: projectPath }));
      assert.deepEqual((await client.get<TerminalListResponse>(`/api/v1/terminals?executorId=${executorId}`)).terminals, inventory.terminals);
    }
  });
  return { retainedTerminal, controllerId: gateway.instanceId, executorCatalogKind: 'usable-operation-projection', ...evidence.report() };
}
