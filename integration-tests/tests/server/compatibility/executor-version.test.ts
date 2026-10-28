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
    test(`${artifacts.stage}: contract workflows and controller restart ${controller.sourceSha.slice(0, 8)}/${worker.sourceSha.slice(0, 8)} (${direction})`, async () => {
      let pair: CompatibilityPair | undefined;
      try {
        pair = await CompatibilityPair.start(controller, worker, direction);
        expect(pair.controller.authToken).toBeNull();
        expect(pair.controller.credentials).toBeNull();
        const result = await contractWorkflows(pair);
        const terminal = result.retainedTerminal as Record<string, unknown>;
        expect(terminal).not.toBeNull();
        await cliRestartContexts(pair, 'capture-cli-context');
        await pair.restartController(artifacts.current);
        expect(pair.controller.authToken).toBeNull();
        expect(await pair.driver({ kind: 'terminal-resume', executorId: pair.executorId,
          terminalId: stringField(terminal, 'terminalId'), terminalRuntimeId: stringField(terminal, 'terminalRuntimeId'),
          previousControllerId: stringField(result, 'controllerId'), workerConfig: pair.workerDirs.config,
        })).toEqual({ retained: true });
        await cliRestartContexts(pair, 'check-cli-restart');
        await contractWorkflows(pair);
      } catch (error) { await diagnostics(direction, pair, error); throw error; }
      finally { await pair?.dispose(); }
    }, 240_000);
  }

  const replacements: readonly (readonly [CompatibilityArtifact, CompatibilityArtifact])[] = artifacts.baselines.length
    ? artifacts.baselines.flatMap(baseline => [[baseline, baseline], [artifacts.current, baseline]] as const)
    : [[artifacts.current, artifacts.current]];
  for (const [controller, initialWorker] of replacements) {
    const successors = initialWorker === artifacts.current ? [artifacts.current] : [artifacts.current, initialWorker];
    const sequence = [initialWorker, ...successors].map(worker => worker.sourceSha.slice(0, 8)).join(' -> ');
    test(`${artifacts.stage}: fixed controller ${controller.sourceSha.slice(0, 8)}, worker ${sequence} (${direction})`, async () => {
      let pair: CompatibilityPair | undefined;
      try {
        pair = await CompatibilityPair.start(controller, initialWorker, direction);
        const controllerPid = pair.controller.pid;
        await contractWorkflows(pair);
        for (const worker of successors) {
          const ready = await pair.replaceWorker(worker);
          expect(pair.controller.pid).toBe(controllerPid);
          const catalog = await pair.driver({ kind: 'catalog', executorId: pair.executorId });
          expect(catalog.instanceId).toBe(ready.instanceId);
          expect(catalog.agents).toContainEqual(expect.objectContaining({ id: 'shell' }));
          await contractWorkflows(pair);
        }
      } catch (error) { await diagnostics(direction, pair, error); throw error; }
      finally { await pair?.dispose(); }
    }, 360_000);
  }

  test(`real worker inventory/schema replacement preserves incompatible saved settings (${direction})`, async () => {
    let pair: CompatibilityPair | undefined;
    try {
      pair = await CompatibilityPair.start(artifacts.current, artifacts.current, direction, 'original');
      const before = await pair.driver({ kind: 'catalog', executorId: pair.executorId });
      expect(before.agents).toContainEqual({ id: 'compat-primary', label: 'Original', schemaVersion: 1, fileMimeTypes: ['text/plain'] });
      expect(before.agents).toContainEqual(expect.objectContaining({ id: 'compat-removed' }));
      const started = await pair.driver({ kind: 'synthetic-turn', executorId: pair.executorId, projectPath: pair.workerDirs.project, schemaVersion: 1 });
      expect(started).toMatchObject({ accepted: true, finished: true });
      const chatId = stringField(started, 'chatId');
      const saved = await pair.driver({ kind: 'saved-settings', chatId });
      const controllerPid = pair.controller.pid;
      for (const inventory of ['changed', 'schema', 'empty', 'original']) {
        const ready = await pair.replaceWorker(artifacts.current, inventory);
        expect(pair.controller.pid).toBe(controllerPid);
        const catalog = await pair.driver({ kind: 'catalog', executorId: pair.executorId });
        expect(catalog.instanceId).toBe(ready.instanceId);
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
            expect(resumed).toMatchObject({ accepted: true, finished: false, error: 'Invalid settings for compat-primary' });
            expect(await readFile(join(pair.workerDirs.root, 'effects.jsonl'), 'utf8')).toBe(effects);
            const fresh = await pair.driver({ kind: 'synthetic-turn', executorId: pair.executorId,
              projectPath: pair.workerDirs.project, schemaVersion: 2 });
            expect(fresh).toMatchObject({ accepted: true, finished: true });
          } else expect(resumed).toMatchObject({ accepted: true, finished: true });
        }
        expect(await pair.driver({ kind: 'saved-settings', chatId })).toEqual(saved);
      }
    } catch (error) { await diagnostics(direction, pair, error); throw error; }
    finally { await pair?.dispose(); }
  }, 240_000);
}

async function contractWorkflows(pair: CompatibilityPair): Promise<Record<string, unknown>> {
  const result = await pair.driver({ kind: 'contract-workflows', executorId: pair.executorId, projectPath: pair.workerDirs.project,
    controllerConfig: pair.controllerDirs.config, workerConfig: pair.workerDirs.config, home: pair.workerDirs.home,
    cliArtifacts: [artifacts.current, ...artifacts.baselines], expectedUnsupported: [],
  });
  expect(result.checked).toEqual(['files-read', 'files-save', 'files-list', 'mkdir', 'git-primary', 'git-bulk',
    'cli-direct', 'execution-direct', 'schedules-direct', 'cli-gateway', 'execution-gateway', 'schedules-gateway', 'terminals']);
  expect(result.unsupported).toEqual([]);
  expect(result.executorCatalogKind).toBe('usable-operation-projection');
  expect(result.contracts).toMatchObject({
    executor: { 'files.read': [1], 'files.list': [1], 'git.getQuickSummary': [1], 'terminals.list': [1] },
    'direct-cli': { 'cli.chats.start': [1] }, 'gateway-cli': { 'cli.chats.start': [1] },
  });
  return result;
}

async function cliRestartContexts(pair: CompatibilityPair, kind: 'capture-cli-context' | 'check-cli-restart'): Promise<void> {
  for (const [index, artifact] of [artifacts.current, ...artifacts.baselines].entries()) {
    for (const runtime of ['controller', 'executor'] as const) {
      const result = await pair.cliDriver(artifact, { version: 1, kind, runtime,
        configDir: runtime === 'controller' ? pair.controllerDirs.config : pair.workerDirs.config,
        contextPath: join(pair.root, `cli-context-${index}-${runtime}.json`),
      });
      expect(result).toEqual(kind === 'capture-cli-context' ? { captured: true } : { staleRejected: true, freshSucceeded: true });
    }
  }
}

async function diagnostics(direction: string, pair: CompatibilityPair | undefined, error: unknown): Promise<void> {
  const directory = join(artifacts.current.repoRoot, 'integration-tests/artifacts/compatibility');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${Date.now()}-${direction}.log`), `${String(error)}\n${pair?.diagnostics() ?? ''}`);
}
