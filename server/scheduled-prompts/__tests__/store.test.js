import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { ScheduledPromptRunLog } from '../run-log.ts';
import { ScheduledPromptStore } from '../store.ts';

const createdDirs = [];

async function tempDir() {
  const dir = path.join(os.tmpdir(), `garcon-scheduled-prompts-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

function scheduledPrompt(id, schedule) {
  return {
    id,
    schedule,
    target: { type: 'existing-chat', chatId: '123', busyBehavior: 'queue' },
    prompt: `Prompt ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('scheduled prompt persistence', () => {
  afterEach(async () => {
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('persists ordered mutations with revision conflicts and private permissions', async () => {
    const dir = await tempDir();
    const store = new ScheduledPromptStore(dir);
    await store.init();

    await store.create(
      scheduledPrompt('a', {
        type: 'once',
        nextRunAt: '2030-01-01T09:00:00.000Z',
      }),
      0,
    );
    await store.create(
      scheduledPrompt('b', {
        type: 'once',
        nextRunAt: '2030-01-02T09:00:00.000Z',
      }),
      1,
    );
    await store.reorder(['b', 'a'], 2);

    expect(store.revision).toBe(3);
    expect(store.list().map((entry) => entry.id)).toEqual(['b', 'a']);
    await expect(store.remove('a', 2)).rejects.toMatchObject({
      code: 'SCHEDULED_PROMPT_REVISION_CONFLICT',
      status: 409,
    });

    const persisted = JSON.parse(await fs.readFile(path.join(dir, 'scheduled-prompts.json'), 'utf8'));
    expect(persisted.prompts.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect((await fs.stat(path.join(dir, 'scheduled-prompts.json'))).mode & 0o777).toBe(0o600);
  });

  it('loads legacy new-chat targets without tags as an empty tag list', async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, 'scheduled-prompts.json'),
      JSON.stringify({
        version: 1,
        revision: 1,
        prompts: [
          {
            id: 'legacy-new-chat',
            schedule: { type: 'once', nextRunAt: '2030-01-01T09:00:00.000Z' },
            target: {
              type: 'new-chat',
              agentId: 'codex',
              projectPath: '/workspace/project',
              model: 'gpt-5',
              apiProviderId: null,
              modelEndpointId: null,
              modelProtocol: null,
              permissionMode: 'acceptEdits',
              thinkingMode: 'high',
              agentSettingsById: {},
            },
            prompt: 'Review the project',
            createdAt: '2029-01-01T00:00:00.000Z',
            updatedAt: '2029-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const store = new ScheduledPromptStore(dir);
    await store.init();

    expect(store.list()[0].target.tags).toEqual([]);
  });

  it('claims once and recurring occurrences before dispatch', async () => {
    const dir = await tempDir();
    const store = new ScheduledPromptStore(dir);
    await store.init();
    await store.create(
      scheduledPrompt('once', {
        type: 'once',
        nextRunAt: '2030-01-01T09:00:00.000Z',
      }),
      0,
    );
    await store.create(
      scheduledPrompt('repeat', {
        type: 'recurring',
        intervalDays: 2,
        nextRunAt: '2030-01-02T09:00:00.000Z',
        endAt: '2030-01-04T09:00:00.000Z',
      }),
      1,
    );

    const once = await store.claimOccurrence('once', '2030-01-01T09:00:00.000Z');
    expect(once?.nextScheduledPrompt).toBeNull();
    expect(store.get('once')).toBeNull();

    const first = await store.claimOccurrence('repeat', '2030-01-02T09:00:00.000Z');
    expect(first?.nextScheduledPrompt?.schedule.nextRunAt).toBe('2030-01-04T09:00:00.000Z');
    const final = await store.claimOccurrence('repeat', '2030-01-04T09:00:00.000Z');
    expect(final?.nextScheduledPrompt).toBeNull();
    expect(store.get('repeat')).toBeNull();
  });

  it('drops missed one-offs and advances recurring prompts without replay', async () => {
    const dir = await tempDir();
    const store = new ScheduledPromptStore(dir);
    await store.init();
    await store.create(
      scheduledPrompt('once', {
        type: 'once',
        nextRunAt: '2030-01-02T09:00:00.000Z',
      }),
      0,
    );
    await store.create(
      scheduledPrompt('repeat', {
        type: 'recurring',
        intervalDays: 2,
        nextRunAt: '2030-01-01T09:00:00.000Z',
        endAt: null,
      }),
      1,
    );

    const result = await store.reconcileMissed(new Date('2030-01-10T12:00:00.000Z'));

    expect(result.changed).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(store.get('once')).toBeNull();
    expect(store.get('repeat')?.schedule.nextRunAt).toBe('2030-01-11T09:00:00.000Z');
  });
});

describe('scheduled prompt process-local helpers', () => {
  it('keeps a bounded, defensive run log', () => {
    const log = new ScheduledPromptRunLog();
    for (let index = 0; index < 205; index += 1) {
      log.append(`entry\n${index}`, new Date('2030-01-01T00:00:00.000Z'));
    }
    const entries = log.list();
    expect(entries).toHaveLength(200);
    expect(entries[0]).toContain('entry 5');
    entries.push('mutated');
    expect(log.list()).toHaveLength(200);
  });
});
