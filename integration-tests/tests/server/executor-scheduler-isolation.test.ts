import { expect, setSystemTime, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ScheduledPrompt, ScheduledPromptDefinitionInput } from '../../../common/scheduled-prompts.js';
import { ScheduledPromptDispatcher } from '../../../server/controller/scheduled-prompts/dispatcher.js';
import { ScheduledPromptRunLog } from '../../../server/controller/scheduled-prompts/run-log.js';
import { ScheduledPromptScheduler, cronExpressionForUtcInstant, type CronRuntime } from '../../../server/controller/scheduled-prompts/scheduler.js';
import { ScheduledPromptStore } from '../../../server/controller/scheduled-prompts/store.js';
import { remoteFixture } from '../../../server/remote/__tests__/integration-fixture.js';
import { withTimeout } from '../../support/deferred.js';

class ManualCron implements CronRuntime {
  readonly jobs: { job: Bun.CronJob; fire: () => unknown }[] = [];
  schedule(expression: string, handler: (this: Bun.CronJob) => unknown): Bun.CronJob {
    const job = {
      cron: expression, stop() { return this; }, ref() { return this; }, unref() { return this; },
      [Symbol.dispose]() {},
    } satisfies Bun.CronJob;
    this.jobs.push({ job, fire: () => handler.call(job) });
    return job;
  }
}

for (const dialer of ['controller', 'worker'] as const) {
  for (const method of ['create', 'update'] as const) {
    test(`a slow remote project check does not delay Local schedules during ${method} (${dialer} dials)`, async () => {
      const root = await mkdtemp(join(homedir(), 'garcon-executor-scheduler-'));
      const fixture = await remoteFixture(dialer, undefined, root);
      const projects = await fixture.executor.getProjectService();
      const nativeProjects = await fixture.generations[0]!.executor.getProjectService();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const inspect = nativeProjects.inspect.bind(nativeProjects);
      const inspection = spyOn(nativeProjects, 'inspect').mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        return inspect(...args);
      });
      const store = new ScheduledPromptStore(root);
      const cron = new ManualCron();
      const sent: string[] = [];
      const executorId = '22222222-2222-4222-8222-222222222222';
      const scheduler = new ScheduledPromptScheduler({
        store, cron, runLog: new ScheduledPromptRunLog(), chats: { getChat: () => null },
        agents: { hasAgent: () => true, assertExecutionModeSelectionSupported() {} },
        preambles: { snapshot: () => ({ revision: 0, preambles: [] }) },
        inspectProject: async (projectPath, selectedExecutor) => {
          expect(selectedExecutor).toBe(executorId);
          return (await projects.inspect({ projectPath })).resolution;
        },
        dispatcher: new ScheduledPromptDispatcher({
          chatIds: { allocate() { throw new Error('Unexpected new chat'); } },
          commands: {
            async submitScheduledStart() { throw new Error('Unexpected new chat'); },
            async submitScheduledExistingChat(input) {
              sent.push(input.chatId);
              return { type: 'sent', chatId: input.chatId };
            },
          },
        }),
      });
      let saving: Promise<unknown> | undefined;
      let firing: Promise<unknown> | undefined;
      let refreshing: Promise<unknown> | undefined;
      try {
        const due = Date.parse('2030-01-01T09:00:00.000Z');
        setSystemTime(new Date(due - 30_000));
        await store.init();
        const local = {
          id: 'local-due', schedule: { type: 'once', nextRunAt: new Date(due).toISOString() },
          target: { type: 'existing-chat', chatId: '1111111111111111', busyBehavior: 'queue' },
          prompt: 'Synthetic scheduled prompt', createdAt: '2029-01-01T00:00:00.000Z', updatedAt: '2029-01-01T00:00:00.000Z',
        } satisfies ScheduledPrompt;
        await store.create(local, 0);
        await store.create({ ...local, id: 'editable', schedule: { type: 'once', nextRunAt: '2030-01-02T09:00:00.000Z' } }, store.revision);
        await scheduler.start();
        const scheduledPrompt: ScheduledPromptDefinitionInput = {
          schedule: { type: 'once', runAtUtc: '2030-01-02T12:00:00.000Z' },
          target: {
            type: 'new-chat', executorId, agentId: 'test', projectPath: root, model: 'test-model',
            permissionMode: 'default', thinkingMode: 'medium', apiProviderId: null, modelEndpointId: null, modelProtocol: null,
            agentSettingsById: { test: { ownerId: 'test', schemaVersion: 1, values: {} } },
            tags: [], preambleChoice: { mode: 'defaults' },
          },
          prompt: 'Synthetic remote prompt',
        };
        saving = scheduler[method]({ id: 'editable', expectedRevision: store.revision, scheduledPrompt }).catch(error => error);
        await withTimeout(entered.promise, 3000, () => 'Worker project inspection did not start');
        refreshing = scheduler.snapshotAfterReconciliation();
        setSystemTime(new Date(due + 5_000));
        const occurrence = cron.jobs.find(({ job }) => job.cron === cronExpressionForUtcInstant(new Date(due).toISOString()))!;
        firing = Promise.resolve(occurrence.fire());
        await withTimeout(firing, 1000, () => 'Local scheduled occurrence blocked on remote inspection');
        expect(sent).toEqual([local.target.chatId]);
        setSystemTime(new Date(due + 65_000));
        release.resolve();
        expect(await saving).toMatchObject({ code: 'SCHEDULED_PROMPT_REVISION_CONFLICT' });
        const reopened = new ScheduledPromptStore(root);
        await reopened.init();
        expect(reopened.list()).toEqual([store.get('editable')!]);
        expect(reopened.get('editable')!.target.type).toBe('existing-chat');
      } finally {
        release.resolve();
        await Promise.allSettled([saving, firing, refreshing]);
        scheduler.stop();
        setSystemTime();
        inspection.mockRestore();
        await fixture.dispose();
        await rm(root, { recursive: true, force: true });
      }
    }, 15_000);
  }
}
