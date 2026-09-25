import { expect, test } from 'bun:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverRuntime } from '../../../cli/discovery.js';
import { GarconClient } from '../../../cli/garcon-client.js';
import { shellQuote } from '../../../cli/shell-quote.js';
import { parseTicketWriteResult } from '../../../common/ticket-records.js';
import { effectiveNodeId } from '../../../common/execution-nodes.js';
import type { TerminalCreateResponse, TerminalListResponse } from '../../../common/terminal.js';
import type { PrimaryWsServerMessage } from '../../../common/ws-protocol.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';
import { GarconTestClient } from '../../support/garcon-client.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';

const CLI = fileURLToPath(new URL('../../../cli/main.ts', import.meta.url));

async function runtimeFile(fixture: IntegrationFixture): Promise<string> {
  const directory = join(fixture.executionDirs.workspace, 'run');
  const names = (await readdir(directory)).filter((name) => name.startsWith('cli-') && name.endsWith('.json'));
  expect(names).toHaveLength(1);
  return join(directory, names[0]!);
}

async function runCli(fixture: IntegrationFixture, args: string[], runtime?: string) {
  return runWorkerCommand(fixture, [process.execPath, CLI, ...args], runtime);
}

async function runWorkerCommand(fixture: IntegrationFixture, argv: string[], runtime?: string) {
  const child = Bun.spawn(argv, {
    cwd: fixture.executionDirs.project,
    env: { ...process.env, GARCON_CLI_RUNTIME: runtime ?? '',
      GARCON_WORKSPACE: runtime ? 'unrelated-inherited-workspace' : '',
      GARCON_CONFIG_DIR: runtime ? '/missing' : fixture.executionDirs.config },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

async function attach(client: GarconTestClient, terminalId: string, inventory: TerminalListResponse) {
  const attachmentId = crypto.randomUUID();
  client.sendTerminal({ type: 'terminal-attach', terminalId, attachmentId, attachmentEpoch: inventory.attachmentEpoch,
    clientId: 'cli-test', afterSequence: 0, intent: 'restore' });
  await client.waitForEvent((message): message is Extract<PrimaryWsServerMessage, { type: 'terminal-attached' }> =>
    message.type === 'terminal-attached' && message.attachmentId === attachmentId, 'CLI shell attachment');
  return attachmentId;
}

async function shellCommand(client: GarconTestClient, terminalId: string, attachmentId: string, command: string) {
  const cursor = client.markEvents();
  const marker = crypto.randomUUID();
  client.sendTerminal({ type: 'terminal-input', terminalId, attachmentId,
    data: `${command}; printf '\\n%s\\n' '${marker}'\r` });
  let output = '';
  await client.waitForEvent((message): message is Extract<PrimaryWsServerMessage, { type: 'terminal-output' }> => {
    if (message.type !== 'terminal-output' || message.attachmentId !== attachmentId) return false;
    output += message.data;
    return output.includes(`\r\n${marker}\r\n`);
  }, 'CLI shell command', { afterIndex: cursor, timeoutMs: 20_000 });
  return output;
}

for (const backend of ['remote-controller-dials', 'remote-node-dials'] as const) {
  test(`CLI gateway preserves targeting, node authority and a retained shell across restart (${backend})`, async () => {
    await withIntegrationFixture(`execution-cli-${backend}`, async (fixture) => {
      let client = fixture.client;
      const nodeId = client.nodeId;
      const runtime = await runtimeFile(fixture);
      const discover = () => discoverRuntime({ configDir: fixture.executionDirs.config });
      await expect(discover()).rejects.toThrow('HTTP 403');
      await client.patch(`/api/v1/execution-nodes/${nodeId}`, { allowControllerCli: true });
      const connection = await discover();
      expect(connection).toMatchObject({ defaultNodeId: nodeId, workspaceName: 'cli-node-integration' });
      const missing = await runCli(fixture, ['status', fixture.newChatId(), '--messages', '0']);
      expect(missing).toMatchObject({ exitCode: 2, stdout: '' });
      expect(missing.stderr).toContain('Session not found (HTTP 404, SESSION_NOT_FOUND)');
      const oldInvocation = new GarconClient(connection);
      const agent = fixture.directAgents.openAi;
      const started = await runCli(fixture, ['start', '--cwd', fixture.executionDirs.project, '--agent', agent.agentId,
        '--provider', agent.provider.providerId, '--endpoint', agent.provider.endpointId, '--model', agent.provider.model, 'Synthetic remote CLI task.']);
      expect(started).toMatchObject({ exitCode: 0, stderr: '' });
      const chatId = /^chat id: (\d{16})/m.exec(started.stdout)?.[1];
      expect(chatId).toBeDefined();
      expect((await client.getChatSnapshot(chatId!)).chat).toMatchObject({ nodeId, projectPath: fixture.executionDirs.project });
      const resumed = await runCli(fixture, ['resume', chatId!, '--model', agent.provider.model, 'Synthetic CLI continuation.'], runtime);
      expect(resumed).toMatchObject({ exitCode: 0, stderr: '' });
      expect(resumed.stdout).toContain('echo:Synthetic CLI continuation.');
      const local = await GarconTestClient.connect(fixture.garcon.baseUrl, { authToken: fixture.garcon.authToken, nodeId: 'local' });
      try {
        const localAgent = { ...agent, provider: await local.createOpenAiProvider(fixture.fakeProviders.openAi.baseUrl) };
        const localId = fixture.newChatId();
        const turn = await local.startChat(local.directStartRequest({ chatId: localId, projectPath: fixture.dirs.project,
          agent: localAgent, content: 'Synthetic Local task.' }));
        await local.waitForTurnTerminal(localId, turn.turnId!);
        const continued = await runCli(fixture, ['resume', localId, '--model', localAgent.provider.model, 'Synthetic cross-node continuation.'], runtime);
        expect(continued, continued.stderr).toMatchObject({ exitCode: 0 });
        expect(effectiveNodeId((await local.getChatSnapshot(localId)).chat.nodeId)).toBe('local');
      } finally { await local.close(); }
      const created = await runCli(fixture, ['ticket', 'create', '--title', 'Synthetic node ticket', '--json']);
      expect(created.exitCode).toBe(0);
      expect(created.stderr).toContain(`--runtime-file $'${runtime}'`);
      expect(created.stderr).not.toContain('--config-dir');
      const ticket = parseTicketWriteResult(JSON.parse(created.stdout));
      expect(ticket.ticket).toMatchObject({ project: basename(fixture.executionDirs.project), createdBy: { kind: 'node', nodeId } });
      const claim = await runCli(fixture, ['ticket', 'claim', ticket.ticket.id, '--expected-revision', String(ticket.ticket.revision), '--json'], runtime);
      expect(claim, claim.stderr).toMatchObject({ exitCode: 0 });
      expect(parseTicketWriteResult(JSON.parse(claim.stdout)).ticket.assignee).toEqual({ kind: 'node', nodeId });

      const inventory = await client.get<TerminalListResponse>(`/api/v1/terminals?nodeId=${nodeId}`);
      const { terminal } = await client.post<TerminalCreateResponse>('/api/v1/terminals', {
        nodeId, expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: 'cli-shell', requestedInitialWorkingDirectory: fixture.executionDirs.project,
      });
      let attachment = await attach(client, terminal.terminalId, inventory);
      client.sendTerminal({ type: 'terminal-input', terminalId: terminal.terminalId, attachmentId: attachment, data: 'stty -echo\r' });
      const command = `${shellQuote(process.execPath)} ${shellQuote(CLI)} status ${chatId} --messages 0 --json`;
      expect(await shellCommand(client, terminal.terminalId, attachment, command)).toContain(`"id": "${chatId}"`);
      await fixture.crashAndRestartGarcon({ preserveExecutionWorker: true });
      client = fixture.client;
      expect(await runtimeFile(fixture)).toBe(runtime);
      expect(await oldInvocation.verifyRuntime()).toBe(false);
      await expect(oldInvocation.listChats()).rejects.toThrow('restarted');
      expect((await discover()).instanceId).not.toBe(connection.instanceId);
      const retryId = /^Request: (.+)$/m.exec(created.stderr)?.[1];
      expect(retryId).toBeDefined();
      const retry = await runCli(fixture, ['ticket', 'create', '--title', 'Synthetic node ticket', '--project', ticket.ticket.project,
        '--request-id', retryId!, '--expected-store-id', ticket.storeId, '--json'], runtime);
      expect(retry, retry.stderr).toMatchObject({ exitCode: 0 });
      expect(parseTicketWriteResult(JSON.parse(retry.stdout))).toEqual(ticket);
      attachment = await attach(client, terminal.terminalId, await client.get<TerminalListResponse>(`/api/v1/terminals?nodeId=${nodeId}`));
      expect(await shellCommand(client, terminal.terminalId, attachment, command)).toContain(`"id": "${chatId}"`);
      await client.patch(`/api/v1/execution-nodes/${nodeId}`, { allowControllerCli: false });
      expect(await shellCommand(client, terminal.terminalId, attachment, command)).toContain('HTTP 403');
      await client.patch(`/api/v1/execution-nodes/${nodeId}`, { allowControllerCli: true });
      expect(await shellCommand(client, terminal.terminalId, attachment, command)).toContain(`"id": "${chatId}"`);
      await client.delete('/api/v1/terminals', { terminalId: terminal.terminalId, requestId: 'cli-shell-end' });
    }, { executionBackend: backend, projectRoots: 'separate', namedWorkspace: 'cli-node-integration',
      serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/sh' } });
  }, 90_000);
}

test('a real permission-approved Claude tool inherits worker CLI discovery and calls back over the same channel', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  try {
    await withIntegrationFixture('execution-cli-provider', async (fixture) => {
      const nodeId = fixture.client.nodeId;
      await fixture.client.patch(`/api/v1/execution-nodes/${nodeId}`, { allowControllerCli: true });
      const output = join(fixture.executionDirs.project, 'synthetic-cli-output.json');
      const command = `${shellQuote(process.execPath)} ${shellQuote(CLI)} list agents --json > ${shellQuote(output)}`;
      environment.model.scriptTurn([claudeToolUse('synthetic_cli_tool', 'Bash', { command })]);
      environment.model.scriptTurn([claudeText('Synthetic CLI completed.')]);
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({ chatId, projectPath: fixture.executionDirs.project, command: 'Run the synthetic CLI query.' }));
      const permission = await fixture.client.waitForTransientPermission(chatId,
        (row) => row.message.type === 'permission-request' && row.message.requestedTool.type === 'bash-tool-use',
        { afterIndex: cursor, timeoutMs: 60_000 });
      const runtime = await runtimeFile(fixture);
      const status = await runCli(fixture, ['status', chatId, '--messages', '0']);
      expect(status, status.stderr).toMatchObject({ exitCode: 0 });
      const allow = /^allow command: (garcon-cli .+)$/m.exec(status.stdout)?.[1];
      expect(allow).toContain(permission.permissionOccurrenceId);
      expect(allow).toContain('--runtime-file');
      expect(allow).not.toContain('--config-dir');
      const decision = await runWorkerCommand(fixture, ['/bin/sh', '-c',
        `${shellQuote(process.execPath)} ${shellQuote(CLI)}${allow!.slice('garcon-cli'.length)}`], runtime);
      expect(decision, decision.stderr).toMatchObject({ exitCode: 0 });
      await fixture.client.waitForTurnTerminal(chatId, turn.turnId!, { afterIndex: cursor, timeoutMs: 60_000 });
      const result = JSON.parse(await readFile(output, 'utf8'));
      expect(result.agents).toContainEqual(expect.objectContaining({ id: 'claude' }));
      environment.model.assertSettled();
    }, { executionBackend: 'remote-node-dials', projectRoots: 'separate', serverEnvironment: environment.serverEnvironment });
  } finally { environment.dispose(); }
}, 120_000);

test('gateway startup failure keeps worker execution and terminals available without falling back to Local CLI', async () => {
  await withIntegrationFixture('execution-cli-unavailable', async (fixture) => {
    const client = fixture.client;
    const nodeId = client.nodeId;
    const local = await discoverRuntime({ configDir: fixture.dirs.config, workspace: 'cli-no-gateway' });
    expect(local.defaultNodeId).toBe('local');
    const chatId = fixture.newChatId();
    const turn = await client.startChat(client.directStartRequest({ chatId, projectPath: fixture.executionDirs.project,
      agent: fixture.directAgents.openAi, content: 'Synthetic task without CLI.' }));
    await client.waitForTurnTerminal(chatId, turn.turnId!);
    expect((await client.getChatSnapshot(chatId)).chat.nodeId).toBe(nodeId);
    const inventory = await client.get<TerminalListResponse>(`/api/v1/terminals?nodeId=${nodeId}`);
    const { terminal } = await client.post<TerminalCreateResponse>('/api/v1/terminals', {
      nodeId, expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: 'cli-unavailable-shell',
      requestedInitialWorkingDirectory: fixture.executionDirs.project,
    });
    const attachment = await attach(client, terminal.terminalId, inventory);
    client.sendTerminal({ type: 'terminal-input', terminalId: terminal.terminalId, attachmentId: attachment, data: 'stty -echo\r' });
    const command = `GARCON_CONFIG_DIR=${shellQuote(fixture.dirs.config)} GARCON_WORKSPACE=cli-no-gateway ${shellQuote(process.execPath)} ${shellQuote(CLI)} list agents --json`;
    const output = await shellCommand(client, terminal.terminalId, attachment, command);
    expect(output).toContain('cannot read a secure runtime descriptor');
    expect(output).toContain(join(fixture.executionDirs.workspace, 'run', 'cli-'));
    expect(output).not.toContain('"agents":');
    await client.delete('/api/v1/terminals', { terminalId: terminal.terminalId, requestId: 'cli-unavailable-shell-end' });
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate', namedWorkspace: 'cli-no-gateway',
    serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/sh' },
    prepareWorkspace: (directories) => writeFile(join(directories.workspace, 'run'), 'Synthetic gateway directory blocker'),
  });
}, 60_000);
