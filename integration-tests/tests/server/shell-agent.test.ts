import { expect, test } from 'bun:test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelCatalogResponse } from '../../../common/model-catalog.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';
import { cliEnvironment } from '../../support/cli-environment.js';
import { rejectionOf } from '../../support/promise-assertions.js';

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
      expect(agent).toMatchObject({ executionPolicy: 'literal', selectionKind: 'execution-variant', selectionLabel: 'Shell', supportedPermissionModes: [], generation: null });
      expect(agent?.models.some(model => model.value === 'sh')).toBe(true);

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

      expect(await rejectionOf(client.refinePrompt({ draft: 'echo command', target: 'prompt', subject: { kind: 'chat', chatId } })))
        .toMatchObject({ status: 422, body: { errorCode: 'PROMPT_REFINEMENT_UNAVAILABLE' } });
      const before = (await client.getMessages(chatId)).messages.map(row => row.message).filter(message => ['user-message', 'command-output', 'command-result'].includes(message.type));
      await client.reloadChat(chatId);
      const after = (await client.getMessages(chatId)).messages.map(row => row.message).filter(message => ['user-message', 'command-output', 'command-result'].includes(message.type));
      expect(after).toEqual(before);

      const forkId = fixture.newChatId();
      await client.forkChat({ sourceChatId: chatId, chatId: forkId, allowHandoffFork: true });
      const frozen = (await client.getMessages(forkId)).messages.map(row => row.message)
        .filter(message => ['user-message', 'command-output', 'command-result'].includes(message.type));
      expect(frozen).toEqual(before);
      const forkRun = await client.runChat({ chatId: forkId, clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(), command: 'printf fork-only' });
      await client.waitForTurnTerminal(forkId, forkRun.turnId);
      await client.waitForProcessing(forkId, false);
      await client.reloadChat(forkId);
      expect((await client.getMessages(forkId)).messages.filter(row => row.message.type === 'user-message'))
        .toHaveLength(before.filter(message => message.type === 'user-message').length + 1);

      if (backend !== 'in-process') await client.patch(`/api/v1/executors/${client.executorId}`, { allowControllerCli: true });
      const cliStart = await runCli(fixture, ['start', '--agent', 'shell', '--model', 'sh', '--cwd', next,
        'printf "<garcon-get-chat-id />"']);
      expect(cliStart).toMatchObject({ exitCode: 0, stderr: '' });
      expect(cliStart.stdout).toMatch(/^chat id: \d{16}\nturn id: [^\n]+\n<garcon-get-chat-id \/>\n$/);
      const cliChatId = /^chat id: (\d{16})/m.exec(cliStart.stdout)![1]!;
      const silent = await runCli(fixture, ['resume', cliChatId, 'true']);
      expect(silent).toMatchObject({ exitCode: 0, stderr: '' });
      expect(silent.stdout).toMatch(/^chat id: \d{16}\nturn id: [^\n]+\n$/);
      const failed = await runCli(fixture, ['resume', cliChatId, 'exit 7']);
      expect(failed.exitCode).not.toBe(0);
      expect(failed.stderr).toContain('Exit 7');
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(0);
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(0);

      await fixture.restartGarcon();
      await fixture.client.reloadChat(chatId);
      const recovered = (await fixture.client.getMessages(chatId)).messages.map(row => row.message)
        .filter(message => ['user-message', 'command-output', 'command-result'].includes(message.type));
      expect(recovered).toEqual(before);
      expect((await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)?.projectPath).toBe(next);
    }, { executionBackend: backend, projectRoots: 'separate' });
  }, 60_000);
}
