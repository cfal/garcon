import { describe, expect, test } from 'bun:test';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

const CREATED_AT = '2026-01-01T00:00:00.000Z';
const INTERVAL_DAYS = [14, 14, 21, 7, 1];

function legacyScheduledPrompt(index: number, intervalDays: number) {
  return {
    id: `scheduled-${index}`,
    schedule: {
      type: 'recurring',
      intervalDays,
      nextRunAt: `2099-0${index + 1}-01T09:00:00.000Z`,
      endAt: null,
    },
    target: {
      type: 'existing-chat',
      chatId: '1000000000000000',
      busyBehavior: 'queue',
    },
    prompt: `Run scheduled prompt ${index}`,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function legacyScheduledPromptsFile() {
  return {
    version: 1,
    revision: 50,
    prompts: INTERVAL_DAYS.map((days, index) => legacyScheduledPrompt(index, days)),
  };
}

describe('scheduled prompt persistence migration', () => {
  test('migrates every legacy recurring prompt before serving the snapshot', async () => {
    await withIntegrationFixture(
      'scheduled-prompt-migration',
      async (fixture) => {
        const scheduledPromptsPath = join(fixture.dirs.workspace, 'scheduled-prompts.json');
        const snapshot = await fixture.client.getScheduledPrompts();

        expect(snapshot.revision).toBe(50);
        expect(snapshot.prompts.map((scheduledPrompt) => scheduledPrompt.schedule)).toEqual(
          INTERVAL_DAYS.map((days, index) => ({
            type: 'recurring',
            intervalHours: days * 24,
            nextRunAt: `2099-0${index + 1}-01T09:00:00.000Z`,
            endAt: null,
          })),
        );

        const migrated = JSON.parse(await readFile(scheduledPromptsPath, 'utf8'));
        expect(migrated.version).toBe(2);
        expect(migrated.revision).toBe(50);
        expect(migrated.prompts).toHaveLength(5);
        expect(
          migrated.prompts.every(
            (scheduledPrompt: { schedule: Record<string, unknown> }) => !('intervalDays' in scheduledPrompt.schedule),
          ),
        ).toBe(true);
        expect((await stat(scheduledPromptsPath)).mode & 0o777).toBe(0o600);
        const backupNames = (await readdir(fixture.dirs.workspace)).filter((entry) =>
          entry.startsWith('scheduled-prompts.json.v1-backup-'),
        );
        expect(backupNames).toHaveLength(1);
        const backupPath = join(fixture.dirs.workspace, backupNames[0]);
        expect(await readFile(backupPath, 'utf8')).toBe(JSON.stringify(legacyScheduledPromptsFile()));
        expect((await stat(backupPath)).mode & 0o777).toBe(0o600);

        await fixture.restartGarcon();
        expect(await fixture.client.getScheduledPrompts()).toEqual(snapshot);
        expect(
          (await readdir(fixture.dirs.workspace)).filter((entry) =>
            entry.startsWith('scheduled-prompts.json.v1-backup-'),
          ),
        ).toEqual(backupNames);
        expect(
          (await readdir(fixture.dirs.workspace)).filter((entry) =>
            entry.startsWith('scheduled-prompts.json.v2-backup-'),
          ),
        ).toEqual([]);
      },
      {
        prepareWorkspace: async ({ workspace }) => {
          await writeFile(
            join(workspace, 'scheduled-prompts.json'),
            JSON.stringify(legacyScheduledPromptsFile()),
            { mode: 0o644 },
          );
        },
      },
    );
  });
});
