import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import crypto, { randomUUID } from 'crypto';
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

async function seedScheduledPrompts(dir, file) {
  const filePath = path.join(dir, 'scheduled-prompts.json');
  await fs.writeFile(filePath, JSON.stringify(file));
  return filePath;
}

async function scheduledPromptBackupPaths(dir) {
  return (await fs.readdir(dir))
    .filter((entry) => entry.startsWith('scheduled-prompts.json.v1-backup-'))
    .map((entry) => path.join(dir, entry));
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

  it('atomically migrates the saved day-based recurring prompts without dropping records', async () => {
    const dir = await tempDir();
    const intervalDays = [14, 14, 21, 7, 1];
    const filePath = await seedScheduledPrompts(dir, {
      version: 1,
      revision: 50,
      prompts: intervalDays.map((days, index) =>
        scheduledPrompt(`legacy-${index}`, {
          type: 'recurring',
          intervalDays: days,
          nextRunAt: `2030-0${index + 1}-01T09:00:00.000Z`,
          endAt: null,
        }),
      ),
    });
    const originalContents = await fs.readFile(filePath, 'utf8');

    const store = new ScheduledPromptStore(dir);
    await store.init();

    expect(store.revision).toBe(50);
    const prompts = store.list();
    expect(prompts).toHaveLength(5);
    expect(prompts.map((entry) => entry.schedule.intervalHours)).toEqual([14 * 24, 14 * 24, 21 * 24, 7 * 24, 24]);
    const migrated = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(migrated.version).toBe(2);
    expect(migrated.revision).toBe(50);
    expect(migrated.prompts).toHaveLength(5);
    expect(migrated.prompts.every((entry) => !('intervalDays' in entry.schedule))).toBe(true);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    const backupPaths = await scheduledPromptBackupPaths(dir);
    expect(backupPaths).toHaveLength(1);
    expect(await fs.readFile(backupPaths[0], 'utf8')).toBe(originalContents);
    expect((await fs.stat(backupPaths[0])).mode & 0o777).toBe(0o600);

    const migratedContents = await fs.readFile(filePath, 'utf8');
    await new ScheduledPromptStore(dir).init();
    expect(await fs.readFile(filePath, 'utf8')).toBe(migratedContents);
    expect(await scheduledPromptBackupPaths(dir)).toEqual(backupPaths);
  });

  it('migrates mixed version-one schedules and prefers valid intervalHours', async () => {
    const dir = await tempDir();
    await seedScheduledPrompts(dir, {
      version: 1,
      revision: 8,
      prompts: [
        scheduledPrompt('legacy', {
          type: 'recurring',
          intervalDays: 7,
          nextRunAt: '2030-01-01T09:00:00.000Z',
          endAt: null,
        }),
        scheduledPrompt('hours', {
          type: 'recurring',
          intervalDays: 99,
          intervalHours: 6,
          nextRunAt: '2030-01-02T09:00:00.000Z',
          endAt: null,
        }),
        scheduledPrompt('invalid-hours', {
          type: 'recurring',
          intervalDays: 2,
          intervalHours: 0,
          nextRunAt: '2030-01-03T09:00:00.000Z',
          endAt: null,
        }),
        scheduledPrompt('once', {
          type: 'once',
          nextRunAt: '2030-01-04T09:00:00.000Z',
        }),
      ],
    });

    const store = new ScheduledPromptStore(dir);
    await store.init();

    expect(store.list().map((entry) => entry.schedule)).toEqual([
      {
        type: 'recurring',
        intervalHours: 7 * 24,
        nextRunAt: '2030-01-01T09:00:00.000Z',
        endAt: null,
      },
      {
        type: 'recurring',
        intervalHours: 6,
        nextRunAt: '2030-01-02T09:00:00.000Z',
        endAt: null,
      },
      {
        type: 'recurring',
        intervalHours: 2 * 24,
        nextRunAt: '2030-01-03T09:00:00.000Z',
        endAt: null,
      },
      { type: 'once', nextRunAt: '2030-01-04T09:00:00.000Z' },
    ]);
  });

  it('backs up invalid legacy intervals before excluding them from the migrated file', async () => {
    const dir = await tempDir();
    const invalidIntervals = [0, -3, 1.5, 3_651, '7'];
    const filePath = await seedScheduledPrompts(dir, {
      version: 1,
      revision: 4,
      prompts: [
        scheduledPrompt('valid', {
          type: 'recurring',
          intervalDays: 1,
          nextRunAt: '2030-01-01T09:00:00.000Z',
          endAt: null,
        }),
        ...invalidIntervals.map((interval, index) =>
          scheduledPrompt(`invalid-${index}`, {
            type: 'recurring',
            intervalDays: interval,
            nextRunAt: '2030-01-01T09:00:00.000Z',
            endAt: null,
          }),
        ),
      ],
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = new ScheduledPromptStore(dir);
      await store.init();

      expect(store.list().map((entry) => entry.id)).toEqual(['valid']);
      const backupPaths = await scheduledPromptBackupPaths(dir);
      expect(backupPaths).toHaveLength(1);
      const backupPath = backupPaths[0];
      const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'));
      expect(backup.version).toBe(1);
      expect(backup.prompts).toHaveLength(6);
      expect((await fs.stat(backupPath)).mode & 0o777).toBe(0o600);
      expect(warn).toHaveBeenCalledWith(
        '[scheduled-prompts]',
        `Ignored 5 invalid or duplicate scheduled prompt records while loading scheduled-prompts.json. Original file backed up to ${backupPath}.`,
      );
      expect(JSON.parse(await fs.readFile(filePath, 'utf8')).prompts).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps version one intact when its migration write fails', async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, 'scheduled-prompts.json');
    const persisted = JSON.stringify({
      version: 1,
      revision: 2,
      prompts: [
        scheduledPrompt('legacy', {
          type: 'recurring',
          intervalDays: 1,
          nextRunAt: '2030-01-01T09:00:00.000Z',
          endAt: null,
        }),
      ],
    });
    await fs.writeFile(filePath, persisted);

    await fs.mkdir(path.join(dir, `.scheduled-prompts.json.${process.pid}.migration-write-failure.tmp`));
    const originalRandomUUID = crypto.randomUUID;
    crypto.randomUUID = () => 'migration-write-failure';
    try {
      await expect(new ScheduledPromptStore(dir).init()).rejects.toMatchObject({ code: 'EISDIR' });
    } finally {
      crypto.randomUUID = originalRandomUUID;
    }

    expect(await fs.readFile(filePath, 'utf8')).toBe(persisted);
  });

  it('uses the migrated interval for occurrence advancement', async () => {
    const dir = await tempDir();
    await seedScheduledPrompts(dir, {
      version: 1,
      revision: 6,
      prompts: [
        scheduledPrompt('weekly', {
          type: 'recurring',
          intervalDays: 7,
          nextRunAt: '2030-01-01T09:00:00.000Z',
          endAt: null,
        }),
      ],
    });
    const store = new ScheduledPromptStore(dir);
    await store.init();

    const result = await store.claimOccurrence('weekly', '2030-01-01T09:00:00.000Z');

    expect(result?.nextScheduledPrompt?.schedule.nextRunAt).toBe('2030-01-08T09:00:00.000Z');
  });

  it('uses the migrated interval for missed-run reconciliation', async () => {
    const dir = await tempDir();
    await seedScheduledPrompts(dir, {
      version: 1,
      revision: 50,
      prompts: [
        scheduledPrompt('weekly', {
          type: 'recurring',
          intervalDays: 7,
          nextRunAt: '2030-01-01T09:00:00.000Z',
          endAt: null,
        }),
      ],
    });
    const store = new ScheduledPromptStore(dir);
    await store.init();

    const result = await store.reconcileMissed(new Date('2030-01-15T09:00:00.000Z'), {
      includeCurrentMinute: true,
    });

    expect(result).toEqual({
      changed: true,
      events: [
        {
          scheduledPromptId: 'weekly',
          message: 'Skipped 3 missed occurrences; next run is 2030-01-22T09:00:00.000Z.',
        },
      ],
    });
    expect(store.revision).toBe(51);
    expect(store.get('weekly')?.schedule.nextRunAt).toBe('2030-01-22T09:00:00.000Z');
  });

  it('does not apply the day-based migration to version-two files', async () => {
    const dir = await tempDir();
    const filePath = await seedScheduledPrompts(dir, {
      version: 2,
      revision: 9,
      prompts: [
        scheduledPrompt('days-only', {
          type: 'recurring',
          intervalDays: 7,
          nextRunAt: '2030-01-01T09:00:00.000Z',
          endAt: null,
        }),
      ],
    });
    const persisted = await fs.readFile(filePath, 'utf8');
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = new ScheduledPromptStore(dir);
      await store.init();

      expect(store.list()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        '[scheduled-prompts]',
        'Ignored 1 invalid or duplicate scheduled prompt record while loading scheduled-prompts.json.',
      );
      expect(await fs.readFile(filePath, 'utf8')).toBe(persisted);
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects future scheduled prompt file versions', async () => {
    const dir = await tempDir();
    await seedScheduledPrompts(dir, { version: 3, revision: 0, prompts: [] });

    await expect(new ScheduledPromptStore(dir).init()).rejects.toThrow('Unsupported scheduled-prompts.json version: 3');
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
        intervalHours: 1,
        nextRunAt: '2030-01-02T09:00:00.000Z',
        endAt: '2030-01-02T11:00:00.000Z',
      }),
      1,
    );

    const once = await store.claimOccurrence('once', '2030-01-01T09:00:00.000Z');
    expect(once?.nextScheduledPrompt).toBeNull();
    expect(store.get('once')).toBeNull();

    const first = await store.claimOccurrence('repeat', '2030-01-02T09:00:00.000Z');
    expect(first?.nextScheduledPrompt?.schedule.nextRunAt).toBe('2030-01-02T10:00:00.000Z');
    const second = await store.claimOccurrence('repeat', '2030-01-02T10:00:00.000Z');
    expect(second?.nextScheduledPrompt?.schedule.nextRunAt).toBe('2030-01-02T11:00:00.000Z');
    const final = await store.claimOccurrence('repeat', '2030-01-02T11:00:00.000Z');
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
        nextRunAt: '2030-01-01T08:00:00.000Z',
      }),
      0,
    );
    await store.create(
      scheduledPrompt('repeat', {
        type: 'recurring',
        intervalHours: 2,
        nextRunAt: '2030-01-01T09:00:00.000Z',
        endAt: null,
      }),
      1,
    );

    const result = await store.reconcileMissed(new Date('2030-01-01T14:30:00.000Z'));

    expect(result.changed).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(store.get('once')).toBeNull();
    expect(store.get('repeat')?.schedule.nextRunAt).toBe('2030-01-01T15:00:00.000Z');
  });

  it('includes the current minute only when startup reconciliation requests it', async () => {
    const dir = await tempDir();
    const store = new ScheduledPromptStore(dir);
    await store.init();
    await store.create(
      scheduledPrompt('repeat', {
        type: 'recurring',
        intervalHours: 1,
        nextRunAt: '2030-01-01T09:00:00.000Z',
        endAt: null,
      }),
      0,
    );

    const scheduledMinute = new Date('2030-01-01T09:00:00.000Z');
    expect(await store.reconcileMissed(scheduledMinute)).toEqual({
      changed: false,
      events: [],
    });
    expect(store.get('repeat')?.schedule.nextRunAt).toBe('2030-01-01T09:00:00.000Z');

    const result = await store.reconcileMissed(scheduledMinute, {
      includeCurrentMinute: true,
    });
    expect(result.changed).toBe(true);
    expect(result.events[0]?.message).toContain('Skipped 1 missed occurrence;');
    expect(store.get('repeat')?.schedule.nextRunAt).toBe('2030-01-01T10:00:00.000Z');
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
