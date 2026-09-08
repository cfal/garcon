import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { DomainError } from '../../lib/domain-error.ts';
import { ScheduledPromptRunLog } from '../run-log.ts';
import { bunCronRuntime, cronExpressionForUtcInstant, ScheduledPromptScheduler } from '../scheduler.ts';
import { ScheduledPromptStore } from '../store.ts';
import { parseGarconSchedule, garconScheduleActionContent } from '../../../common/garcon-schedule.ts';
import { AtomicJsonWriteError } from '../../lib/json-file-store.ts';

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
    schedule: { type: 'recurring', intervalMinutes: 60, nextRunAt, endAt: null },
    target: { type: 'existing-chat', chatId: '123', busyBehavior: 'queue' },
    prompt: 'Continue the work',
    createdAt: '2029-01-01T00:00:00.000Z',
    updatedAt: '2029-01-01T00:00:00.000Z',
  };
}

function recurringDefinition(firstRunAtUtc, intervalMinutes = 1440) {
  return {
    schedule: {
      type: 'recurring',
      intervalMinutes,
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
      intervalMinutes: 1440,
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

async function sameChatScheduler() {
  const store = new ScheduledPromptStore(await tempDir());
  await store.init();
  const cron = new FakeCron();
  const scheduler = new ScheduledPromptScheduler({
    store, cron, runLog: new ScheduledPromptRunLog(), agents: agentCapabilities(),
    chats: { getChat: (chatId) => chatId === '123' ? {} : null },
    dispatcher: { dispatch: async () => ({ message: 'sent' }) },
  });
  return { store, cron, scheduler };
}

function commandScheduleRequest(content) {
  const command = parseGarconSchedule(content);
  if (!command) throw new Error('Invalid test command');
  return {
    chatId: '123', firstRun: command.firstRun, intervalMinutes: command.intervalMinutes,
    endAtUtc: command.endAtUtc, busyBehavior: command.busyBehavior,
    prompt: garconScheduleActionContent(command.body),
  };
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

  it.each([1, 5, 60, 90])('claims and registers the next %i-minute occurrence before dispatch', async (intervalMinutes) => {
    const dir = await tempDir();
    const store = new ScheduledPromptStore(dir);
    await store.init();
    const scheduledFor = '2030-01-01T09:00:00.000Z';
    const prompt = recurringPrompt(scheduledFor);
    prompt.schedule.intervalMinutes = intervalMinutes;
    await store.create(prompt, 0);
    const nextRunAt = new Date(Date.parse(scheduledFor) + intervalMinutes * 60_000).toISOString();
    const cron = new FakeCron();
    const observations = [];
    const runLog = new ScheduledPromptRunLog();
    const scheduler = new ScheduledPromptScheduler({
      store,
      runLog,
      dispatcher: {
        async dispatch(prompt) {
          observations.push({ prompt, persisted: store.get(prompt.id) });
          expect(cron.jobs.some((job) => !job.stopped && job.expression === cronExpressionForUtcInstant(nextRunAt))).toBe(true);
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
    expect(observations[0].persisted.schedule.nextRunAt).toBe(nextRunAt);
    expect(occurrence.stopped).toBe(true);
    expect(runLog.list().at(-1)).toContain('Prompt sent to chat 123.');
  });

  it('persists an hourly recurring definition and registers its first run', async () => {
    const dir = await tempDir();
    const store = new ScheduledPromptStore(dir);
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

    const snapshot = await scheduler.create({
      expectedRevision: 0,
      scheduledPrompt: recurringDefinition('2030-01-01T09:15:00.000Z', 360),
    });

    expect(snapshot.prompts[0]?.schedule).toMatchObject({
      type: 'recurring',
      intervalMinutes: 360,
      nextRunAt: '2030-01-01T09:15:00.000Z',
    });
    expect(cron.jobs.some((job) => job.expression === '15 9 1 1 *')).toBe(true);
    scheduler.stop();
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

  it.each(['1m', '5m', '90m', '366d', '3650d'])('accepts parser-to-scheduler every=%s at one acceptance clock', async (every) => {
    const { store, scheduler, cron } = await sameChatScheduler();
    const request = commandScheduleRequest(`<garcon-schedule every="${every}" />`);
    const now = new Date('2030-01-01T12:00:20.000Z');
    const result = await scheduler.scheduleForChat(request, now);
    const nextRunAt = new Date(Math.ceil((now.getTime() + request.intervalMinutes * 60_000) / 60_000) * 60_000).toISOString();
    expect(result.scheduledPrompt).toMatchObject({
      target: { type: 'existing-chat', chatId: '123', busyBehavior: 'queue' },
      prompt: '<garcon-schedule-action />',
      schedule: { type: 'recurring', intervalMinutes: request.intervalMinutes, nextRunAt, endAt: null },
      createdAt: now.toISOString(),
    });
    expect(cron.jobs[0].expression).toBe(cronExpressionForUtcInstant(nextRunAt));
    expect(store.list()).toEqual([result.scheduledPrompt]);
    scheduler.stop();
  });

  it('validates the same-chat runtime boundary independently of the command parser', async () => {
    const { store, scheduler } = await sameChatScheduler();
    const request = commandScheduleRequest('<garcon-schedule every="5m" />');
    const now = new Date('2030-01-01T12:00:20.000Z');
    for (const invalid of [
      { firstRun: null }, { firstRun: { type: 'other' } },
      { firstRun: { type: 'after', minutes: 366 * 1440 } },
      { firstRun: { type: 'after', minutes: 1.5 } },
      { firstRun: { type: 'after', minutes: 0 } },
      { intervalMinutes: null }, { intervalMinutes: 0 }, { intervalMinutes: 1.5 },
      { intervalMinutes: 3650 * 1440 + 1 }, { intervalMinutes: undefined },
      { busyBehavior: 'steer' }, { endAtUtc: 'invalid' },
      { firstRun: { type: 'at', atUtc: '2030-01-01T12:00:00.000Z' } },
      { firstRun: { type: 'at', atUtc: '2030-01-01T12:01:01.000Z' } },
      { firstRun: { type: 'after', minutes: 1 }, intervalMinutes: null, endAtUtc: '2030-01-02T12:00:00.000Z' },
    ]) await expect(scheduler.scheduleForChat({ ...request, ...invalid }, now)).rejects.toMatchObject({ code: 'SCHEDULED_PROMPT_VALIDATION_FAILED' });
    expect(store.list()).toEqual([]);
    scheduler.stop();
  });

  it('serializes same-chat creation with HTTP creation without external revisions or retry', async () => {
    const { store, scheduler } = await sameChatScheduler();
    const now = new Date('2030-01-01T12:00:20.000Z');
    const request = commandScheduleRequest('<garcon-schedule in="1m" busy="skip">Check.</garcon-schedule>');
    const [http, result] = await Promise.all([
      scheduler.create({ expectedRevision: 0, scheduledPrompt: recurringDefinition('2030-01-02T12:00:00.000Z', 5) }),
      scheduler.scheduleForChat(request, now),
    ]);
    expect(http.revision).toBe(1);
    expect(result.snapshot.revision).toBe(2);
    expect(new Set(store.list().map((prompt) => prompt.id)).size).toBe(2);
    expect(result.scheduledPrompt).toMatchObject({
      schedule: { type: 'once', nextRunAt: '2030-01-01T12:02:00.000Z' },
      target: { type: 'existing-chat', chatId: '123', busyBehavior: 'skip' },
    });
    scheduler.stop();
  });

  it('reports uncertain creation with its schedule ID after a renamed write or failed rollback', async () => {
    const { store, scheduler, cron } = await sameChatScheduler();
    const request = commandScheduleRequest('<garcon-schedule in="1m" />');
    const now = new Date('2030-01-01T12:00:00.000Z');
    const create = spyOn(store, 'create').mockRejectedValue(new AtomicJsonWriteError('sync failed', true));
    try {
      await expect(scheduler.scheduleForChat(request, now)).rejects.toMatchObject({
        message: 'Scheduled prompt creation outcome is unknown', scheduleId: expect.any(String),
      });
    } finally { create.mockRestore(); }
    const register = spyOn(cron, 'schedule').mockImplementation(() => { throw new Error('register failed'); });
    const remove = spyOn(store, 'remove').mockRejectedValue(new Error('rollback failed'));
    try {
      await expect(scheduler.scheduleForChat(request, now)).rejects.toMatchObject({
        message: 'Scheduled prompt creation outcome is unknown', scheduleId: expect.any(String),
      });
      expect(store.list()).toHaveLength(1);
    } finally { register.mockRestore(); remove.mockRestore(); scheduler.stop(); }
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
