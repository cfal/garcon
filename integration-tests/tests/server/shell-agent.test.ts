import { expect, test } from 'bun:test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelCatalogResponse } from '../../../common/model-catalog.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';
import { cliEnvironment } from '../../support/cli-environment.js';

async function runCli(fixture: IntegrationFixture, args: string[]) {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('../../../cli/main.ts', import.meta.url)), ...args], {
    cwd: fixture.executionDirs.project,
    env: cliEnvironment({ GARCON_CONFIG_DIR: fixture.executionDirs.config,
      GARCON_RUNTIME: fixture.client.executorId === 'local' ? 'controller' : 'executor' }),
    stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

for (const backend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`Shell literal execution, cwd continuity, queue pause and native Reload (${backend})`, async () => {
    await withIntegrationFixture(`shell-${backend}`, async fixture => {
      const client = fixture.client;
      const projectPath = fixture.executionDirs.project;
      const next = join(projectPath, 'next');
      await mkdir(next);
      const catalog = await client.get<ModelCatalogResponse>(`/api/v1/models?executorId=${client.executorId}`);
      const agent = catalog.catalog.agents.find(entry => entry.id === 'shell');
      expect(agent).toMatchObject({ executionPolicy: 'literal', selectionLabel: 'Shell', supportedPermissionModes: [], generation: null });
      expect(agent).not.toHaveProperty('selectionKind');
      expect(agent?.models.some(model => model.value === 'sh')).toBe(true);
      const auth = await client.get(`/api/v1/agents/auth?agent=shell&executorId=${client.executorId}`);
      expect(auth).toEqual({ shell: { authenticated: false, canReauth: false, label: 'Shell', source: 'none' } });

      const chatId = fixture.newChatId();
      const source = '  printf "<garcon-get-chat-id />\\n"; printf diagnostic >&2; cd next\n ';
      const started = await client.startChat({
        chatId, agentId: 'shell', model: 'sh', projectPath, permissionMode: 'default', thinkingMode: 'none',
        agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} },
        origin: 'interactive', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: source,
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      await client.waitForProcessing(chatId, false);
      expect((await client.listChats()).sessions.find(chat => chat.id === chatId)?.projectPath).toBe(next);
      const messages = (await client.getMessages(chatId)).messages.map(row => row.message);
      expect(messages.find(message => message.type === 'user-message')).toMatchObject({ content: source, metadata: { contentMode: 'literal' } });
      expect(messages.some(message => message.type === 'command-output' && message.content.includes('<garcon-get-chat-id />'))).toBe(true);
      expect(messages.some(message => message.type === 'command-output' && message.channel === 'stderr' && message.content.includes('diagnostic'))).toBe(true);
      expect(messages.filter(message => message.type === 'user-message')).toHaveLength(1);

      const run = await client.runChat({ chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: 'sleep 0.2; false' });
      await client.enqueueNew(chatId, 'printf queued > result.txt');
      await client.waitForTurnTerminal(chatId, run.turnId);
      await client.waitForProcessing(chatId, false);
      const queued = (await client.getExecutionControl(chatId)).queue;
      expect(queued.pause).toMatchObject({ kind: 'turn-failed' });
      expect(queued.entries).toHaveLength(1);
      expect(await Bun.file(join(next, 'result.txt')).exists()).toBe(false);
      const resumedAt = client.markEvents();
      await client.resumeQueue(chatId, queued.pause!.id);
      await client.waitForProcessing(chatId, false, { afterIndex: resumedAt });
      expect(await readFile(join(next, 'result.txt'), 'utf8')).toBe('queued');

      await client.runChat({ chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
        command: "trap '' TERM; printf ready > interrupt-ready; while :; do sleep 1; done" });
      for (let retry = 0; retry < 1000 && !await Bun.file(join(next, 'interrupt-ready')).exists(); retry++) {
        await Bun.sleep(10);
      }
      expect(await Bun.file(join(next, 'interrupt-ready')).exists()).toBe(true);
      const successor = 'printf replacement >> replacement.txt';
      await client.enqueueNew(chatId, successor);
      const interruptCursor = client.markEvents();
      expect((await client.interruptAndSend({ chatId, clientRequestId: crypto.randomUUID() })).outcome)
        .toBe('interrupt-requested');
      const input = await client.waitForCommittedUserInput(chatId, successor, { afterIndex: interruptCursor });
      expect((await client.waitForTurnTerminal(chatId, undefined, {
        afterIndex: client.events().lastIndexOf(input) + 1,
      })).type).toBe('agent-run-finished');
      await client.waitForProcessing(chatId, false);
      expect(await readFile(join(next, 'replacement.txt'), 'utf8')).toBe('replacement');
      expect((await client.getExecutionControl(chatId)).queue.pause).toBeNull();

      const noisy = await client.runChat({ chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
        command: "sleep 0.2; head -c 131072 /dev/zero | tr '\\0' x; printf tail; printf diagnostic >&2" });
      const tailCursor = client.markEvents();
      await client.enqueueNew(chatId, 'printf after-tail > after-tail.txt');
      expect((await client.waitForTurnTerminal(chatId, noisy.turnId)).type).toBe('agent-run-finished');
      const tailInput = await client.waitForCommittedUserInput(chatId, 'printf after-tail > after-tail.txt', { afterIndex: tailCursor });
      expect((await client.waitForTurnTerminal(chatId, undefined, {
        afterIndex: client.events().lastIndexOf(tailInput) + 1,
      })).type).toBe('agent-run-finished');
      await client.waitForProcessing(chatId, false);
      expect(await readFile(join(next, 'after-tail.txt'), 'utf8')).toBe('after-tail');
      const tailRows = (await client.getMessages(chatId)).messages.map(row => row.message);
      const tailOutput = tailRows.find(message => message.type === 'command-output' && message.content.endsWith('tail'));
      expect(tailOutput?.type).toBe('command-output');
      if (tailOutput?.type !== 'command-output') throw new Error('Missing retained tail');
      const retained = tailRows.filter(message => message.type === 'command-output' && message.commandId === tailOutput.commandId);
      expect(retained).toHaveLength(2);
      expect(retained.reduce((bytes, message) => bytes + (message.type === 'command-output' ? Buffer.byteLength(message.content) : 0), 0)).toBe(64 * 1024);
      expect(tailRows.find(message => message.type === 'command-result' && message.commandId === tailOutput.commandId))
        .toMatchObject({ result: { outcome: 'finished', capture: 'truncated' } });

      const before = (await client.getMessages(chatId)).messages.map(row => row.message).filter(message => ['user-message', 'command-output', 'command-result'].includes(message.type));
      await client.reloadChat(chatId);
      const after = (await client.getMessages(chatId)).messages.map(row => row.message).filter(message => ['user-message', 'command-output', 'command-result'].includes(message.type));
      // Stop admits the successor before late cleanup rows; native Reload groups each command.
      expect(after.map(message => JSON.stringify(message)).sort())
        .toEqual(before.map(message => JSON.stringify(message)).sort());

      const forkId = fixture.newChatId();
      await client.forkChat({ sourceChatId: chatId, chatId: forkId, allowHandoffFork: true });
      const frozen = (await client.getMessages(forkId)).messages.map(row => row.message)
        .filter(message => ['user-message', 'command-output', 'command-result'].includes(message.type));
      expect(frozen).toEqual(after);
      const forkRun = await client.runChat({ chatId: forkId, clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(), command: 'printf fork-only' });
      await client.waitForTurnTerminal(forkId, forkRun.turnId);
      await client.waitForProcessing(forkId, false);
      await client.reloadChat(forkId);
      expect((await client.getMessages(forkId)).messages.filter(row => row.message.type === 'user-message'))
        .toHaveLength(before.filter(message => message.type === 'user-message').length + 1);

      if (backend !== 'in-process') await client.patch(`/api/v1/executors/${client.executorId}`, { allowControllerCli: true });
      const cliAgents = await runCli(fixture, ['list', 'agents', '--json']);
      expect(cliAgents).toMatchObject({ exitCode: 0, stderr: '' });
      expect(JSON.parse(cliAgents.stdout).agents).toContainEqual(expect.objectContaining({
        id: 'shell', executionPolicy: 'literal', selectionLabel: 'Shell',
      }));
      const cliModels = await runCli(fixture, ['list', 'models', '--agent', 'shell', '--json']);
      expect(cliModels).toMatchObject({ exitCode: 0, stderr: '' });
      expect(JSON.parse(cliModels.stdout)).toMatchObject({ agentId: 'shell', selectionLabel: 'Shell' });
      const cliStart = await runCli(fixture, ['start', '--agent', 'shell', '--model', 'sh', '--cwd', next,
        'printf "<garcon-get-chat-id />"']);
      expect(cliStart).toMatchObject({ exitCode: 0, stderr: '' });
      expect(cliStart.stdout).toMatch(/^chat id: \d{16}\nturn id: [^\n]+\n<garcon-get-chat-id \/>\n$/);
      const cliChatId = /^chat id: (\d{16})/m.exec(cliStart.stdout)![1]!;
      const silent = await runCli(fixture, ['resume', cliChatId, 'true']);
      expect(silent).toMatchObject({ exitCode: 0, stderr: '' });
      expect(silent.stdout).toMatch(/^chat id: \d{16}\nturn id: [^\n]+\n$/);
      const large = await runCli(fixture, ['resume', cliChatId,
        "head -c 5242880 /dev/zero | tr '\\0' x; printf receipt-tail"]);
      expect(large).toMatchObject({ exitCode: 0, stderr: '' });
      expect(large.stdout).toEndWith('receipt-tail\n');
      if (backend !== 'in-process') expect(large.stdout).toContain('[CLI output truncated;');
      const cliOutput = (await client.getMessages(cliChatId)).messages.map(row => row.message)
        .find(message => message.type === 'command-output' && message.content.endsWith('receipt-tail'));
      expect(cliOutput?.type === 'command-output' && Buffer.byteLength(cliOutput.content)).toBe(64 * 1024);
      const failed = await runCli(fixture, ['resume', cliChatId, 'exit 7']);
      expect(failed.exitCode).not.toBe(0);
      expect(failed.stderr).toContain('Exit 7');
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(0);
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(0);

      await fixture.restartGarcon();
      await fixture.client.reloadChat(chatId);
      const recovered = (await fixture.client.getMessages(chatId)).messages.map(row => row.message)
        .filter(message => ['user-message', 'command-output', 'command-result'].includes(message.type));
      expect(recovered).toEqual(after);
      expect((await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)?.projectPath).toBe(next);
    }, { executionBackend: backend, projectRoots: 'separate' });
  }, 60_000);
}
