import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScheduledPrompt, ScheduledPromptDefinitionInput, ScheduledPromptRunLogEntry } from '../../../common/scheduled-prompts.js';
import { discoverRuntime } from '../../../cli/discovery.js';
import { GarconClient } from '../../../cli/garcon-client.js';
import { withCliFixture, runCli, cliRuntime } from '../../support/cli-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

const future = '2099-01-01T09:00:00.000Z';
interface ScheduleResult { revision: number; scheduledPrompt: ScheduledPrompt }

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`schedule management through the real CLI (${executionBackend})`, async () => {
    await withCliFixture(`cli-schedules-${executionBackend}`, async fixture => {
      const origin = fixture.client.executorId;
      const invoke = async <T>(args: string[], runtime = cliRuntime(fixture)): Promise<T> => {
        const result = await runCli(fixture, ['schedule', ...args, '--json'], runtime);
        expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: '' });
        return JSON.parse(result.stdout) as T;
      };
      const agent = fixture.directAgents.openAi;
      const definition: ScheduledPromptDefinitionInput = {
        name: 'Synthetic recurring task',
        schedule: { type: 'recurring', firstRunAtUtc: future, intervalMinutes: 60, endAtUtc: null },
        target: {
          type: 'new-chat', executorId: origin, agentId: agent.agentId,
          projectPath: fixture.executionDirs.project, model: agent.provider.model,
          apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
          modelProtocol: agent.provider.protocol, permissionMode: 'default', thinkingMode: 'none',
          agentSettingsById: { [agent.agentId]: agent.agentSettings }, tags: [], preambleChoice: { mode: 'defaults' },
        },
        prompt: 'Synthetic scheduled input',
      };
      expect(await invoke(['list'])).toEqual({ revision: 0, prompts: [] });
      const created = await invoke<ScheduleResult>(['create', '--definition', JSON.stringify(definition)]);
      const id = created.scheduledPrompt.id;
      expect(created).toMatchObject({ revision: 1, scheduledPrompt: { enabled: true, target: { projectPath: fixture.executionDirs.project } } });
      expect(created.scheduledPrompt.target.type).toBe('new-chat');
      if (created.scheduledPrompt.target.type !== 'new-chat') throw new Error('Expected new-chat target');
      expect(created.scheduledPrompt.target.executorId ?? 'local').toBe(origin);
      let revision = (await invoke<ScheduleResult>(['disable', id, '--expected-revision', '1'])).revision;
      const conflict = await runCli(fixture, ['schedule', 'delete', id, '--expected-revision', '1', '--json']);
      expect(conflict).toMatchObject({ exitCode: 3, stdout: '' });
      expect(conflict.stderr).toContain('SCHEDULED_PROMPT_REVISION_CONFLICT');
      expect(conflict.stderr).not.toContain('outcome is unknown');
      definition.name = 'Synthetic renamed task';
      const edited = await invoke<ScheduleResult>(['update', id, '--definition', JSON.stringify(definition), '--expected-revision', String(revision)]);
      revision = edited.revision;
      expect(edited.scheduledPrompt).toMatchObject({ id, enabled: false, name: definition.name, createdAt: created.scheduledPrompt.createdAt });
      expect(await invoke(['show', id])).toEqual(edited);
      expect(await invoke(['list'])).toEqual({ revision, prompts: [edited.scheduledPrompt] });

      const chatId = fixture.newChatId();
      const start = await fixture.client.startChat({ chatId, agentId: 'shell', model: 'notes',
        projectPath: fixture.executionDirs.project, permissionMode: 'default', thinkingMode: 'none',
        agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, origin: 'interactive',
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: 'Synthetic note' });
      await fixture.client.waitForTurnTerminal(chatId, start.turnId);
      await fixture.client.waitForProcessing(chatId, false);
      const literalDefinition: ScheduledPromptDefinitionInput = {
        schedule: { type: 'once', runAtUtc: future },
        target: { type: 'existing-chat', chatId, busyBehavior: 'skip' }, prompt: '  /clear\n{{chat_id}}  \n',
      };
      const literal = await invoke<ScheduleResult>(['create', '--definition', JSON.stringify(literalDefinition),
        '--expected-revision', String(revision)], 'controller');
      expect(literal.scheduledPrompt).toMatchObject({ prompt: literalDefinition.prompt,
        target: { chatId, expectedSelection: { agentId: 'shell', model: 'notes' } } });
      await fixture.client.patch('/api/v1/chats/model', { chatId, model: 'sh' });
      const literalEdited = await invoke<ScheduleResult>(['update', literal.scheduledPrompt.id,
        '--definition', JSON.stringify(literalDefinition), '--expected-revision', String(literal.revision)]);
      expect(literalEdited.scheduledPrompt.target).toEqual(literal.scheduledPrompt.target);
      revision = literalEdited.revision;

      if (origin !== 'local') {
        const localDefinition: ScheduledPromptDefinitionInput = { ...definition, target: {
          type: 'new-chat', executorId: 'local', projectPath: fixture.dirs.project, agentId: 'shell', model: 'notes',
          apiProviderId: null, modelEndpointId: null, modelProtocol: null, permissionMode: 'default', thinkingMode: 'none',
          agentSettingsById: { shell: { ownerId: 'shell', schemaVersion: 1, values: {} } }, tags: [], preambleChoice: { mode: 'defaults' },
        } };
        const local = await invoke<ScheduleResult>(['create', '--definition', JSON.stringify(localDefinition), '--expected-revision', String(revision)]);
        expect(local.scheduledPrompt.target).toMatchObject({ type: 'new-chat', projectPath: fixture.dirs.project });
        expect(local.scheduledPrompt.target.type === 'new-chat' && (local.scheduledPrompt.target.executorId ?? 'local')).toBe('local');
        revision = (await invoke<{ revision: number }>(['delete', local.scheduledPrompt.id, '--expected-revision', String(local.revision)])).revision;
        await fixture.client.patch(`/api/v1/executors/${origin}`, { allowControllerCli: false });
        const denied = await runCli(fixture, ['schedule', 'list', '--json']);
        expect(denied).toMatchObject({ exitCode: 3, stdout: '' });
        expect(denied.stderr).toContain('HTTP 403');
        expect(denied.stderr).toContain('No fallback was attempted');
        await fixture.client.patch(`/api/v1/executors/${origin}`, { allowControllerCli: true });
      }

      const previousConnection = await discoverRuntime({ configDir: fixture.executionDirs.config, runtime: cliRuntime(fixture) });
      const filePath = join(fixture.dirs.workspace, 'scheduled-prompts.json');
      await fixture.restartGarcon({ beforeStart: async () => {
        const file = JSON.parse(await readFile(filePath, 'utf8')) as { prompts: ScheduledPrompt[] };
        file.prompts.find(entry => entry.id === literal.scheduledPrompt.id)!.schedule.nextRunAt = '2020-01-01T09:00:00.000Z';
        await writeFile(filePath, JSON.stringify(file));
      } });
      const persisted = await invoke<ScheduleResult>(['show', id]);
      expect(persisted.scheduledPrompt).toEqual(edited.scheduledPrompt);
      // Fresh endpoint credentials isolate the controller-generation fence from transport and authentication failures.
      const currentConnection = await discoverRuntime({ configDir: fixture.executionDirs.config, runtime: cliRuntime(fixture) });
      const staleClient = new GarconClient({ ...currentConnection, instanceId: previousConnection.instanceId });
      expect(await rejectionOf(staleClient.deleteScheduledPrompt({ id, expectedRevision: persisted.revision })))
        .toMatchObject({ errorCode: 'CLI_CONTROLLER_CHANGED' });
      expect(await invoke(['show', id])).toEqual(persisted);
      const history = await invoke<{ retention: string; capacity: number; runLog: ScheduledPromptRunLogEntry[] }>(['history', literal.scheduledPrompt.id, '--limit', '1']);
      expect(history).toMatchObject({ retention: 'controller-process', capacity: 200 });
      expect(history.runLog).toHaveLength(1);
      expect(history.runLog[0]).toMatchObject({ scheduledPromptId: literal.scheduledPrompt.id, outcome: 'missed' });
      expect(await runCli(fixture, ['schedule', 'show', literal.scheduledPrompt.id])).toMatchObject({ exitCode: 3, stdout: '' });
      await fixture.restartGarcon();
      expect(await invoke(['history', literal.scheduledPrompt.id])).toMatchObject({ runLog: [] });

      revision = (await invoke<ScheduleResult>(['show', id])).revision;
      if (origin !== 'local') {
        await fixture.client.patch(`/api/v1/executors/${origin}`, { enabled: false });
        for (const action of ['create', 'update']) {
          const args = ['schedule', action];
          if (action === 'update') args.push(id);
          args.push('--definition', JSON.stringify(definition), '--expected-revision', String(revision));
          const unavailable = await runCli(fixture, args, 'controller');
          expect(unavailable).toMatchObject({ exitCode: 3, stdout: '' });
          expect(unavailable.stderr).toContain('EXECUTOR_UNAVAILABLE');
          expect(unavailable.stderr).not.toContain('outcome is unknown');
          expect(await invoke(['list'], 'controller')).toEqual({ revision, prompts: [edited.scheduledPrompt] });
        }
      }
      const enabled = await invoke<ScheduleResult>(['enable', id, '--expected-revision', String(revision)], 'controller');
      expect(enabled.scheduledPrompt.enabled).toBe(true);
      const disabled = await invoke<ScheduleResult>(['disable', id, '--expected-revision', String(enabled.revision)], 'controller');
      expect(disabled.scheduledPrompt.enabled).toBe(false);
      expect(await invoke(['delete', id, '--expected-revision', String(disabled.revision)], 'controller'))
        .toEqual({ revision: disabled.revision + 1, id, deleted: true });
      expect(await invoke(['list'], 'controller')).toEqual({ revision: disabled.revision + 1, prompts: [] });
    }, { executionBackend });
  }, 120_000);
}
