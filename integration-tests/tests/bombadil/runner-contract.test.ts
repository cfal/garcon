import { beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertBombadilNotInterrupted, runBombadil } from '../../bombadil/run.js';
import { OwnedBrowserProcesses } from '../../bombadil/processes.js';
import { withTimeout } from '../../support/deferred.js';
import { readTrace, requireCoverage } from '../../bombadil/trace.js';
import { completedWorkflow, uniqueQueueEntries, validPanels } from '../../bombadil/properties.js';
import type { BrowserObservation } from '../../bombadil/browser.js';
import { throwingRejectionOf } from '../../support/promise-assertions.js';

const ROOT = resolve(import.meta.dir, '../..');
beforeEach(assertBombadilNotInterrupted);

interface CanaryOptions {
  expectedError?: RegExp;
  deadlineMs?: number;
  signal?: AbortSignal;
}

async function canary(
  source: string | ((origin: string) => string),
  { expectedError, deadlineMs = 10_000, signal }: CanaryOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'bombadil-canary-'));
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    fetch: request => new URL(request.url).pathname === '/api/canary'
      ? new Response('synthetic API failure', { status: 500 })
      : new Response('<!doctype html><p>synthetic canary</p>', { headers: { 'Content-Type': 'text/html' } }),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const specification = join(directory, 'canary.ts');
  const artifactRoot = join(ROOT, 'artifacts/bombadil');
  await mkdir(artifactRoot, { recursive: true });
  const artifacts = await mkdtemp(join(artifactRoot, 'canary-'));
  try {
    await writeFile(specification, typeof source === 'string' ? source : source(origin), { mode: 0o600 });
    const run = runBombadil({ origin, specification, privateDirectory: directory, artifacts, seconds: 3, deadlineMs, signal });
    if (expectedError) {
      expect(await throwingRejectionOf(run)).toThrow(expectedError);
    } else {
      expect((await run).states).toBeGreaterThan(2);
    }
    const manifest = JSON.parse(await readFile(join(artifacts, 'run.json'), 'utf8'));
    expect(manifest.forcedCleanup).toBe(0);
    for (const entry of await readdir(artifacts, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const contents = await readFile(join(entry.parentPath, entry.name));
      expect(contents.includes('synthetic-canary-token')).toBe(false);
    }
    await rm(artifacts, { recursive: true, force: true });
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

function canarySpecification({
  complete = true,
  invariant = 'observed.current.complete',
  actions = "export const wait = actions(() => ['Wait']);",
} = {}): string {
  return `import { always } from '@antithesishq/bombadil';
import { actions, extract, registerCustomAction } from '@antithesishq/bombadil/browser';
const observed = extract(() => ({ kind: 'garcon-bombadil-v1', complete: ${complete} }));
export const active = always(() => ${invariant});
${actions}`;
}

const base = canarySpecification();

test('real release writes readable traces and observes useful states', () => canary(base), 30_000);
test('false invariant exits nonzero with a readable failure trace', () => canary(
  `${base}\nexport const broken=always(()=>false);`, { expectedError: /exited 2/ },
), 30_000);
test('unfinished liveness cannot pass the external coverage gate', () => canary(
  canarySpecification({ complete: false, invariant: 'true' }), { expectedError: /required workflow/ },
), 30_000);
test('custom-action exceptions fail even when the driver only logs them', () => canary(
  canarySpecification({ actions: `
const fail = registerCustomAction('fail', async () => { throw new Error('synthetic action failure'); });
export const wait = actions(() => [fail()]);` }),
  { expectedError: /failed to apply action/ },
), 30_000);
test('large action-error output cannot hide the failure prefix', () => canary(
  canarySpecification({ actions: `
const fail = registerCustomAction('fail', async () => { throw new Error('synthetic' + 'x'.repeat(40000)); });
export const wait = actions(() => [fail()]);` }),
  { expectedError: /failed to apply action/ },
), 30_000);
test('outer cancellation never becomes a pass', () => canary(
  base, { expectedError: /canceled|ENOENT/, deadlineMs: 1_000 },
), 30_000);
test('caller AbortSignal never becomes a pass', () => canary(
  base, { expectedError: /canceled/, signal: AbortSignal.timeout(1_000) },
), 30_000);
test('API observer catches a same-origin failure without exporting credentials', () => canary(origin => `
import {bootstrap} from ${JSON.stringify(join(ROOT, 'bombadil/browser.ts'))};
${canarySpecification({ invariant: 'errors.current.length === 0' })}
bootstrap(${JSON.stringify({ origin, token: 'synthetic-canary-token', runId: 'canary', chatA: 'a', chatB: 'b', campaign: 'navigation' })});
const errors=extract(({window})=>window.__bombadil.apiErrors);
if(typeof window!=='undefined' && location.origin===${JSON.stringify(origin)}) void fetch('/api/canary');
`, { expectedError: /exited 2/ }), 30_000);
test('syntax errors cannot become empty successful campaigns', () => canary(
  'export const invalid = ;', { expectedError: /Empty Bombadil trace|ENOENT|exited/ },
), 30_000);
test('a specification without actions cannot pass', () => canary(
  canarySpecification({ actions: '' }), { expectedError: /exited|Empty Bombadil trace/ },
), 30_000);

test('missing and truncated traces fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bombadil-trace-'));
  try {
    expect(await throwingRejectionOf(readTrace(join(directory, 'absent')))).toThrow();
    await writeFile(join(directory, 'broken'), '{"timestamp":');
    expect(await throwingRejectionOf(readTrace(join(directory, 'broken')))).toThrow();
    expect(() => requireCoverage({ states: 3, actions: 2, violations: 0, maxCaptureGapMs: 0, observations: [] })).toThrow('required workflow');
    expect(() => requireCoverage({ states: 3, actions: 2, violations: 0, maxCaptureGapMs: 0,
      observations: [{ complete: true }, { complete: false }] })).toThrow('required workflow');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('panel and queue oracles reject duplicates and wrong-chat delivery without conflating text or panels', () => {
  const panel = { chatId: 'a', rows: ['view:1', 'view:2'], text: 'repeated repeated' };
  expect(validPanels([panel, panel], 'a', 'b')).toBe(true);
  expect(validPanels([{ ...panel, rows: ['view:1', 'view:1'] }], 'a', 'b')).toBe(false);
  expect(validPanels([{ ...panel, text: 'bombadilbravo' }], 'a', 'b')).toBe(false);
  for (const marker of ['bombadilalpha', 'bombadilclick', 'bombadilenter', 'bombadilheld', 'bombadilqueued', 'bombadiledited', 'bombadilafterstop']) {
    expect(validPanels([{ ...panel, chatId: 'b', text: `echo:${marker}` }], 'a', 'b')).toBe(false);
  }
  expect(validPanels([{ ...panel, text: 'Failed to render message' }], 'a', 'b')).toBe(false);
  expect(uniqueQueueEntries([['q'], ['q']])).toBe(true);
  expect(uniqueQueueEntries([['q', 'q']])).toBe(false);
});

test('completion requires measured scroll, a new document and current authenticated readiness', () => {
  const observation: BrowserObservation = { kind: 'garcon-bombadil-v1', stage: 10, complete: true,
    documents: 3, reloadBaseline: 2, scrollChanges: 1, randomActions: 30, documentWsOpen: true,
    wsOpens: 3, wsCloses: [], apiErrors: [], actionErrors: [], acceptedTurns: [] };
  expect(completedWorkflow(observation, true)).toBe(true);
  expect(completedWorkflow({ ...observation, scrollChanges: 0 }, true)).toBe(false);
  expect(completedWorkflow({ ...observation, documents: 2 }, true)).toBe(false);
  expect(completedWorkflow({ ...observation, documentWsOpen: false }, true)).toBe(false);
  expect(completedWorkflow({ ...observation, randomActions: 29 }, true)).toBe(false);
  expect(completedWorkflow(observation, false)).toBe(false);
});

test('cleanup detects and kills only nonce-owned processes', async () => {
  const owned = new OwnedBrowserProcesses();
  const child = Bun.spawn(['/bin/sleep', '30'], { env: owned.environment });
  const control = Bun.spawn(['/bin/sleep', '30'], { env: {} });
  try {
    expect(owned.members().map(member => member.pid)).toContain(child.pid);
    expect(await owned.cleanup()).toBeGreaterThanOrEqual(1);
    await withTimeout(child.exited, 5_000, () => 'Owned process survived cleanup');
    expect(control.exitCode).toBeNull();
    expect(owned.members()).toEqual([]);
  } finally {
    child.kill('SIGKILL');
    control.kill('SIGKILL');
    await Promise.all([child.exited, control.exited]);
  }
}, 15_000);
