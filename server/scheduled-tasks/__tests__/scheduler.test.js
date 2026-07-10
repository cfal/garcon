import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { ScheduledTaskRunLog } from '../run-log.ts';
import { cronExpressionForUtcInstant, ScheduledTaskScheduler } from '../scheduler.ts';
import { ScheduledTaskStore } from '../store.ts';

const createdDirs = [];

async function tempDir() {
  const dir = path.join(os.tmpdir(), `garcon-scheduler-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

function recurringTask(nextRunAt) {
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
    schedule: { type: 'recurring', intervalDays: 1, firstRunAtUtc, endAtUtc: null },
    target: { type: 'existing-chat', chatId: '123', busyBehavior: 'queue' },
    prompt: 'Continue the work',
  };
}

class FakeCron {
  jobs = [];

  schedule(expression, handler) {
    const job = {
      expression,
      stopped: false,
      stop() { this.stopped = true; },
      async fire() { await handler.call(this); },
    };
    this.jobs.push(job);
    return job;
  }
}

describe('scheduled task scheduler', () => {
  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('builds exact UTC minute expressions', () => {
    expect(cronExpressionForUtcInstant('2030-07-04T13:25:00.000Z')).toBe('25 13 4 7 *');
  });

  it('claims before dispatch, advances recurrence, and appends an outcome', async () => {
    const dir = await tempDir();
    const store = new ScheduledTaskStore(dir);
    await store.init();
    const scheduledFor = '2030-01-01T09:00:00.000Z';
    await store.create(recurringTask(scheduledFor), 0);
    const cron = new FakeCron();
    const observations = [];
    const runLog = new ScheduledTaskRunLog();
    const scheduler = new ScheduledTaskScheduler({
      store,
      runLog,
      dispatcher: {
        async dispatch(task) {
          observations.push({ task, persisted: store.get(task.id) });
          return { message: 'Task sent to chat 123.' };
        },
      },
      chats: { getChat() { return {}; } },
      agents: { hasAgent() { return true; } },
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
    expect(runLog.list().at(-1)).toContain('Task sent to chat 123.');
  });

  it('keeps the current cron handle active when an edit conflicts', async () => {
    const dir = await tempDir();
    const store = new ScheduledTaskStore(dir);
    await store.init();
    await store.create(recurringTask('2030-01-01T09:00:00.000Z'), 0);
    const cron = new FakeCron();
    const scheduler = new ScheduledTaskScheduler({
      store,
      runLog: new ScheduledTaskRunLog(),
      dispatcher: { async dispatch() { return { message: 'sent' }; } },
      chats: { getChat() { return {}; } },
      agents: { hasAgent() { return true; } },
      cron,
    });
    await scheduler.start(new Date('2029-12-31T00:00:00.000Z'));
    const current = cron.jobs.find((job) => job.expression !== '@hourly');

    await expect(scheduler.update({
      id: 'repeat',
      expectedRevision: 0,
      task: recurringDefinition('2030-01-02T09:00:00.000Z'),
    })).rejects.toMatchObject({ code: 'SCHEDULED_TASK_REVISION_CONFLICT' });

    expect(current.stopped).toBe(false);
    scheduler.stop();
  });

  it('does not let a stale callback evict its replacement handle', async () => {
    const dir = await tempDir();
    const store = new ScheduledTaskStore(dir);
    await store.init();
    await store.create(recurringTask('2030-01-01T09:00:00.000Z'), 0);
    const cron = new FakeCron();
    const scheduler = new ScheduledTaskScheduler({
      store,
      runLog: new ScheduledTaskRunLog(),
      dispatcher: { async dispatch() { return { message: 'sent' }; } },
      chats: { getChat() { return {}; } },
      agents: { hasAgent() { return true; } },
      cron,
    });
    await scheduler.start(new Date('2029-12-31T00:00:00.000Z'));
    const stale = cron.jobs.find((job) => job.expression !== '@hourly');
    await scheduler.update({
      id: 'repeat',
      expectedRevision: 1,
      task: recurringDefinition('2030-01-02T09:00:00.000Z'),
    });
    const replacement = cron.jobs.find((job) => job.expression === '0 9 2 1 *');

    await stale.fire();
    scheduler.stop();

    expect(replacement.stopped).toBe(true);
  });
});
