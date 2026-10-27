import { afterAll, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareArtifacts, type CompatibilityArtifact } from '../../../compatibility/artifacts.js';
import { CompatibilityPair, stringField } from '../../../support/compatibility-pair.js';

const artifacts = await prepareArtifacts();
afterAll(() => artifacts.dispose());
const requested = process.env.GARCON_TEST_EXECUTION_BACKEND;
const directions = requested ? [requested] : ['remote-controller-dials', 'remote-executor-dials'];
for (const direction of directions) {
  if (direction !== 'remote-controller-dials' && direction !== 'remote-executor-dials') throw new Error('Compatibility requires a remote dial direction');
  const pairs: readonly (readonly [CompatibilityArtifact, CompatibilityArtifact])[] = [
    [artifacts.current, artifacts.current],
    ...artifacts.baselines.flatMap(baseline => [[baseline, baseline], [artifacts.current, baseline], [baseline, artifacts.current]] as const),
  ];
  for (const [controller, worker] of pairs) {
    test(`${artifacts.stage}: core workflows and independent restart ${controller.sourceSha.slice(0, 8)}/${worker.sourceSha.slice(0, 8)} (${direction})`, async () => {
      const pair = await CompatibilityPair.start(controller, worker, direction);
      try {
        expect(pair.controller.authToken).toBeNull();
        expect(pair.controller.credentials).toBeNull();
        const result = await pair.driver({ kind: 'core-workflow', executorId: pair.executorId, projectPath: pair.workerDirs.project,
          controllerConfig: pair.controllerDirs.config, workerConfig: pair.workerDirs.config, home: pair.workerDirs.home,
          cliArtifacts: [artifacts.current, ...artifacts.baselines],
        });
        expect(result.checked).toEqual(['files', 'mkdir', 'git-primary', 'git-bulk', 'cli-direct', 'cli-gateway', 'execution', 'schedules', 'terminals']);
        await pair.restartController(artifacts.current);
        expect(pair.controller.authToken).toBeNull();
        expect(await pair.driver({ kind: 'terminal-resume', executorId: pair.executorId,
          terminalId: stringField(result, 'terminalId'), terminalRuntimeId: stringField(result, 'terminalRuntimeId'),
          previousControllerId: stringField(result, 'controllerId'), workerConfig: pair.workerDirs.config,
        })).toEqual({ retained: true });
        await pair.replaceWorker(artifacts.current);
        const catalog = await pair.driver({ kind: 'catalog', executorId: pair.executorId });
        expect(catalog.agents).toBeArray();
      } catch (error) { await diagnostics(pair, error); throw error; }
      finally { await pair.dispose(); }
    }, 240_000);
  }

  test(`real worker inventory/schema replacement preserves incompatible saved settings (${direction})`, async () => {
    const pair = await CompatibilityPair.start(artifacts.current, artifacts.current, direction, 'original');
    try {
      const before = await pair.driver({ kind: 'catalog', executorId: pair.executorId });
      expect(before.agents).toContainEqual({ id: 'compat-primary', label: 'Original', schemaVersion: 1, fileMimeTypes: ['text/plain'] });
      expect(before.agents).toContainEqual(expect.objectContaining({ id: 'compat-removed' }));
      const started = await pair.driver({ kind: 'synthetic-turn', executorId: pair.executorId, projectPath: pair.workerDirs.project, schemaVersion: 1 });
      expect(started).toMatchObject({ accepted: true, finished: true });
      const chatId = stringField(started, 'chatId');
      const saved = await pair.driver({ kind: 'saved-settings', chatId });
      const controllerPid = pair.controller.pid;
      for (const inventory of ['changed', 'schema', 'empty', 'original']) {
        await pair.replaceWorker(artifacts.current, inventory);
        expect(pair.controller.pid).toBe(controllerPid);
        const catalog = await pair.driver({ kind: 'catalog', executorId: pair.executorId });
        expect(catalog.instanceId).not.toBe(before.instanceId);
        if (inventory === 'empty') expect(catalog.agents).toEqual([]);
        else {
          expect(catalog.agents).toContainEqual(expect.objectContaining({ id: inventory === 'original' ? 'compat-removed' : 'compat-added' }));
          expect(catalog.agents).not.toContainEqual(expect.objectContaining({ id: inventory === 'original' ? 'compat-added' : 'compat-removed' }));
          expect(catalog.agents).toContainEqual({ id: 'compat-primary', label: inventory === 'original' ? 'Original' : 'Replacement',
            schemaVersion: inventory === 'schema' ? 2 : 1, fileMimeTypes: inventory === 'original' ? ['text/plain'] : [] });
          const effects = await readFile(join(pair.workerDirs.root, 'effects.jsonl'), 'utf8');
          const resumed = await pair.driver({ kind: 'synthetic-turn', executorId: pair.executorId,
            projectPath: pair.workerDirs.project, schemaVersion: 1, chatId });
          if (inventory === 'schema') {
            expect(resumed).toMatchObject({ accepted: true, finished: false });
            expect(await readFile(join(pair.workerDirs.root, 'effects.jsonl'), 'utf8')).toBe(effects);
            const fresh = await pair.driver({ kind: 'synthetic-turn', executorId: pair.executorId,
              projectPath: pair.workerDirs.project, schemaVersion: 2 });
            expect(fresh).toMatchObject({ accepted: true, finished: true });
          } else expect(resumed).toMatchObject({ accepted: true, finished: true });
        }
        expect(await pair.driver({ kind: 'saved-settings', chatId })).toEqual(saved);
      }
    } catch (error) { await diagnostics(pair, error); throw error; }
    finally { await pair.dispose(); }
  }, 240_000);
}

async function diagnostics(pair: CompatibilityPair, error: unknown): Promise<void> {
  const directory = join(artifacts.current.repoRoot, 'integration-tests/artifacts/compatibility');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${Date.now()}-${pair.direction}.log`), `${String(error)}\n${pair.diagnostics()}`);
}
