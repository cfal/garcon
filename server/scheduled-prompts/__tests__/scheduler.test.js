import { afterEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { DomainError } from '../../lib/domain-error.ts';
import { ScheduledPromptRunLog } from '../run-log.ts';
import { bunCronRuntime, cronExpressionForUtcInstant, ScheduledPromptScheduler } from '../scheduler.ts';
import { ScheduledPromptStore } from '../store.ts';

const createdDirs = [];

async function tempDir() {
  const dir = path.join(os.tmpdir(), `garcon-scheduler-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

function recurringPrompt(nextRunAt) {
  return {
    id: 'repeat',
    schedule: { type: 'recurring', intervalDays: 1, nextRunAt, endAt: null },
    target: { type: 'existing-chat', chatId: '123', busyBehavior: 'queue' },
    prompt: 'Continue the work',
    createdAt: '2029-01-01T00:00:00.000Z',
    updatedAt: '2029-01-01T00:00:00.000Z',
  };
}

function recurringDefinition(firstRunAtUtc) {
  return {
    schedule: {
      type: 'recurring',
      intervalDays: 1,
      firstRunAtUtc,
      endAtUtc: null,
    },
    target: { type: 'existing-chat', chatId: '123', busyBehavior: 'queue' },
    prompt: 'Continue the work',
  };
}

function newChatDefinition(firstRunAtUtc, thinkingMode = 'none') {
  return {
    schedule: {
      type: 'recurring',
      intervalDays: 1,
      firstRunAtUtc,
      endAtUtc: null,
    },
    target: {
      type: 'new-chat',
      agentId: 'amp',
      projectPath: process.cwd(),
      model: 'medium',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'default',
      thinkingMode,
      agentSettingsById: {
        amp: { ownerId: 'amp', schemaVersion: 2, values: {} },
      },
      tags: [],
    },
    prompt: 'Continue the work',
  };
}

function agentCapabilities(supportedThinkingModes = ['none', 'high']) {
  return {
    hasAgent() {
      return true;
    },
    assertExecutionModeSelectionSupported(agentId, selection) {
      if (
        selection.thinkingMode !== undefined
        && !supportedThinkingModes.includes(selection.thinkingMode)
        && !(selection.thinkingMode === 'none' && supportedThinkingModes.length === 0)
      ) {
        throw new DomainError(
          'VALIDATION_FAILED',
          `Thinking mode ${selection.thinkingMode} is not supported by ${agentId}`,
          422,
        );
      }
    },
  };
}

class FakeCron {
  jobs = [];

  schedule(expression, handler) {
    const job = {
      expression,
      stopped: false,
      stop() {
        this.stopped = true;
      },
      async fire() {
        await handler.call(this);
      },
    };
    this.jobs.push(job);
    return job;
  }
}

describe('scheduled prompt scheduler', () => {
  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('builds exact UTC minute expressions', () => {
    expect(cronExpressionForUtcInstant('2030-07-04T13:25:00.000Z')).toBe('25 13 4 7 *');
  });

  it('evaluates UTC cron expressions in UTC', () => {
    const originalCron = Bun.cron;
    const cron = mock(() => ({ stop() {} }));
    Bun.cron = cron;
    try {
      const handler = () => {};
      bunCronRuntime.schedule('25 13 4 7 *', handler);

      expect(cron).toHaveBeenCalledWith('25 13 4 7 *', handler, { tz: 'UTC' });
    } finally {
      Bun.cron = originalCron;
    }
  });

  it('claims before dispatch, advances recurrence, and appends an outcome', async () => {
    const dir = await tempDir();
    const store = new ScheduledPromptStore(dir);
    await store.init();
    const scheduledFor = '2030-01-01T09:00:00.000Z';
    await store.create(recurringPrompt(scheduledFor), 0);
    const cron = new FakeCron();
    const observations = [];
    const runLog = new ScheduledPromptRunLog();
    const scheduler = new ScheduledPromptScheduler({
      store,
      runLog,
      dispatcher: {
        async dispatch(prompt) {
          observations.push({ prompt, persisted: store.get(prompt.id) });
          return { message: 'Prompt sent to chat 123.' };
        },
      },
      chats: {
        getChat() {
          return {};
        },
      },
      agents: agentCapabilities(),
      cron,
    });
    await scheduler.start(new Date('2029-12-31T00:00:00.000Z'));
    const occurrence = cron.jobs.find((job) => job.expression !== '@hourly');
    const originalNow = Date.now;
    Date.now = () => Date.parse(scheduledFor);
    try {
      await occurrence.fire();
    } finally {
      Date.now = originalNow;
      scheduler.stop();
    }

    expect(observations).toHaveLength(1);
    expect(observations[0].persisted.schedule.nextRunAt).toBe('2030-01-02T09:00:00.000Z');
    expect(runLog.list().at(-1)).toContain('Prompt sent to chat 123.');
  });

  it('creates a server-timed one-off prompt for the current chat with skip behavior', async () => {
    const dir = await tempDir();
    const store = new ScheduledPromptStore(dir);
    await store.init();
    const cron = new FakeCron();
    const scheduler = new ScheduledPromptScheduler({
      store,
      runLog: new ScheduledPromptRunLog(),
      dispatcher: {
        async dispatch() {
          return { message: 'sent' };
        },
      },
      chats: {
        getChat(chatId) {
          return chatId === '123' ? {} : null;
        },
      },
      agents: agentCapabilities(),
      cron,
    });
    const invalidations = [];
    scheduler.onInvalidated((reason) => invalidations.push(reason));

    const result = await scheduler.scheduleIn(
      { chatId: ' 123 ', duration: '1m', prompt: '  Check the build  ' },
      new Date('2029-07-10T12:00:45.000Z'),
    );

    expect(result.scheduledPrompt).toMatchObject({
      schedule: { type: 'once', nextRunAt: '2029-07-10T12:02:00.000Z' },
      target: { type: 'existing-chat', chatId: '123', busyBehavior: 'skip' },
      prompt: 'Check the build',
      createdAt: '2029-07-10T12:00:45.000Z',
    });
    expect(result.snapshot.revision).toBe(1);
    expect(result.snapshot.prompts).toEqual([result.scheduledPrompt]);
    expect(cron.jobs).toHaveLength(1);
    expect(cron.jobs[0].expression).toBe('2 12 10 7 *');
    expect(invalidations).toEqual(['created']);
    scheduler.stop();
  });

  it('rejects invalid schedule-in duration, prompt, and chat inputs with typed errors', async () => {
    const dir = await tempDir();
    const store = new ScheduledPromptStore(dir);
    await store.init();
    const scheduler = new ScheduledPromptScheduler({
      store,
      runLog: new ScheduledPromptRunLog(),
      dispatcher: {
        async dispatch() {
          return { message: 'sent' };
        },
      },
      chats: {
        getChat(chatId) {
          return chatId === '123' ? {} : null;
        },
      },
      agents: agentCapabilities(),
      cron: new FakeCron(),
    });
    const now = new Date('2029-07-10T12:00:45.000Z');
    const request = {
      chatId: '123',
      duration: '1m',
      prompt: 'Check the build',
    };

    await expect(scheduler.scheduleIn({ ...request, duration: '2m10s' }, now)).rejects.toMatchObject({
      code: 'SCHEDULE_IN_SUB_MINUTE_UNSUPPORTED',
      status: 400,
    });
    await expect(scheduler.scheduleIn({ ...request, duration: '365d1m' }, now)).rejects.toMatchObject({
      code: 'SCHEDULE_IN_DURATION_TOO_LONG',
      status: 400,
    });
    await expect(scheduler.scheduleIn({ ...request, prompt: '/compact' }, now)).rejects.toMatchObject({
      code: 'SCHEDULED_PROMPT_VALIDATION_FAILED',
      status: 400,
    });
    await expect(scheduler.scheduleIn({ ...request, chatId: 'missing' }, now)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });
    await expect(scheduler.scheduleIn({ ...request, duration: 3 }, now)).rejects.toMatchObject({
      code: 'SCHEDULE_IN_DURATION_REQUIRED',
      status: 400,
    });

    expect(store.list()).toEqual([]);
  });

  it('rejects unsupported new-chat effort before create or update persistence', async () => {
    const dir = await tempDir();
    const store = new ScheduledPromptStore(dir);
    await store.init();
    const scheduler = new ScheduledPromptScheduler({
      store,
      runLog: new ScheduledPromptRunLog(),
      dispatcher: {
        async dispatch() {
          return { message: 'sent' };
        },
      },
      chats: {
        getChat() {
          return null;
        },
      },
      agents: agentCapabilities([]),
      cron: new FakeCron(),
    });

    await expect(scheduler.create({
      expectedRevision: 0,
      scheduledPrompt: newChatDefinition('2030-01-01T09:00:00.000Z', 'high'),
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(store.revision).toBe(0);
    expect(store.list()).toEqual([]);

    const created = await scheduler.create({
      expectedRevision: 0,
      scheduledPrompt: newChatDefinition('2030-01-01T09:00:00.000Z'),
    });
    const scheduledPrompt = created.prompts[0];
    await expect(scheduler.update({
      id: scheduledPrompt.id,
      expectedRevision: created.revision,
      scheduledPrompt: newChatDefinition('2030-01-02T09:00:00.000Z', 'high'),
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });

    expect(store.revision).toBe(created.revision);
    expect(store.get(scheduledPrompt.id)?.target).toMatchObject({ thinkingMode: 'none' });
    scheduler.stop();
  });

  it('keeps the current cron handle active when an edit conflicts', async () => {
    const dir = await tempDir();
    const store = new ScheduledPromptStore(dir);
    await store.init();
    await store.create(recurringPrompt('2030-01-01T09:00:00.000Z'), 0);
    const cron = new FakeCron();
    const scheduler = new ScheduledPromptScheduler({
      store,
      runLog: new ScheduledPromptRunLog(),
      dispatcher: {
        async dispatch() {
          return { message: 'sent' };
        },
      },
      chats: {
        getChat() {
          return {};
        },
      },
      agents: agentCapabilities(),
      cron,
    });
    await scheduler.start(new Date('2029-12-31T00:00:00.000Z'));
    const current = cron.jobs.find((job) => job.expression !== '@hourly');

    await expect(
      scheduler.update({
        id: 'repeat',
        expectedRevision: 0,
        scheduledPrompt: recurringDefinition('2030-01-02T09:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'SCHEDULED_PROMPT_REVISION_CONFLICT' });

    expect(current.stopped).toBe(false);
    scheduler.stop();
  });

  it('does not let a stale callback evict its replacement handle', async () => {
    const dir = await tempDir();
    const store = new ScheduledPromptStore(dir);
    await store.init();
    await store.create(recurringPrompt('2030-01-01T09:00:00.000Z'), 0);
    const cron = new FakeCron();
    const scheduler = new ScheduledPromptScheduler({
      store,
      runLog: new ScheduledPromptRunLog(),
      dispatcher: {
        async dispatch() {
          return { message: 'sent' };
        },
      },
      chats: {
        getChat() {
          return {};
        },
      },
      agents: agentCapabilities(),
      cron,
    });
    await scheduler.start(new Date('2029-12-31T00:00:00.000Z'));
    const stale = cron.jobs.find((job) => job.expression !== '@hourly');
    await scheduler.update({
      id: 'repeat',
      expectedRevision: 1,
      scheduledPrompt: recurringDefinition('2030-01-02T09:00:00.000Z'),
    });
    const replacement = cron.jobs.find((job) => job.expression === '0 9 2 1 *');

    await stale.fire();
    scheduler.stop();

    expect(replacement.stopped).toBe(true);
  });
});
