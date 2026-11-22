import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAgentCliUpdateStatus, type AgentCliUpdateStatus } from '@garcon/common/agent-cli-update';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { CliUpdateService, type CliUpdateServiceOptions } from '../cli-update-service.js';
import { createCliUpdateFixture, type CliUpdateFixture, type NpmCli } from './cli-update-fixture.js';

const PACKAGE = '@anthropic-ai/claude-code';
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

let fixture: CliUpdateFixture;
let cli: NpmCli;
let updated: number;

beforeEach(async () => {
  fixture = await createCliUpdateFixture();
  cli = await fixture.installNpmCli({ name: 'claude', packageName: PACKAGE, version: '2.1.238' });
  updated = 0;
});
afterEach(async () => { await fixture.dispose(); });

// Answers `npm view` with `latest` and installs it on `npm install`, recording its arguments.
async function writeNpm(options: { latest: string; installExit?: number; installVersion?: string }) {
  const log = path.join(fixture.root, 'npm.log');
  await fixture.writeScript(path.join(fixture.bin, 'npm'), `
echo "$@" >> ${JSON.stringify(log)}
case "$1" in
  view) echo '"${options.latest}"' ;;
  install)
    echo "added 1 package"
    echo "npm error synthetic install failure" >&2
    ${options.installExit ? `exit ${options.installExit}` : ''}
    echo "${options.installVersion ?? options.latest} (Synthetic CLI)" > ${JSON.stringify(cli.versionFile)} ;;
esac`);
  return { calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) };
}

function service(overrides: Partial<CliUpdateServiceOptions> = {}): CliUpdateService {
  return new CliUpdateService({
    label: 'Synthetic CLI',
    definition: { packageName: PACKAGE, native: { ownsCommandPath: () => false, args: ['update'] } },
    target: async () => ({ command: cli.launcher, bundled: false }),
    environment: () => fixture.env,
    nativeRelease: async () => ({ key: 'native', lookup: async () => null }),
    onUpdated: () => { updated++; },
    logger: silentLogger,
    now: () => new Date('2026-11-20T00:00:00.000Z'),
    ...overrides,
  });
}

async function settled(updates: CliUpdateService): Promise<AgentCliUpdateStatus> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await updates.status({ refresh: false });
    if (status.run.state !== 'running') return status;
    await Bun.sleep(10);
  }
  throw new Error('The update did not settle');
}

test('reports an outdated npm install with the command that updates it', async () => {
  const npm = await writeNpm({ latest: '2.1.300' });
  const status = await service().status({ refresh: false });
  expect(status).toEqual({
    cliLabel: 'Synthetic CLI',
    installMethod: 'npm',
    installPath: cli.real,
    currentVersion: '2.1.238',
    latestVersion: '2.1.300',
    advisory: 'behind-latest',
    updateCommand: `npm install -g --prefix ${cli.prefix} --allow-scripts=${PACKAGE} ${PACKAGE}@latest`,
    canUpdate: true,
    message: null,
    checkedAt: '2026-11-20T00:00:00.000Z',
    run: { state: 'idle', startedAt: null, finishedAt: null, message: null, output: null },
  });
  expect(await npm.calls()).toEqual([`view --global --json ${PACKAGE}@latest version`]);
});

test('caches the latest version until a refresh', async () => {
  const npm = await writeNpm({ latest: '2.1.300' });
  const updates = service();
  await updates.status({ refresh: false });
  await updates.status({ refresh: false });
  expect(await npm.calls()).toHaveLength(1);
  await updates.status({ refresh: true });
  expect(await npm.calls()).toHaveLength(2);
});

test('updates the CLI and verifies the installed version', async () => {
  const npm = await writeNpm({ latest: '2.1.300' });
  const updates = service();
  const started = await updates.startUpdate();
  expect(started.run).toMatchObject({ state: 'running', startedAt: '2026-11-20T00:00:00.000Z' });
  const status = await settled(updates);
  expect(status.run).toMatchObject({ state: 'succeeded', message: 'Updated Synthetic CLI to 2.1.300. Running chats keep the previous version; new sessions use the update.' });
  expect(status.run.output).toContain('added 1 package');
  expect(status).toMatchObject({ currentVersion: '2.1.300', advisory: 'current' });
  expect(updated).toBe(1);
  expect(await npm.calls()).toContain(`install -g --prefix ${cli.prefix} --allow-scripts=${PACKAGE} ${PACKAGE}@latest`);
});

test('reports a failed update with the line that names the error', async () => {
  await writeNpm({ latest: '2.1.300', installExit: 3 });
  const updates = service();
  await updates.startUpdate();
  const status = await settled(updates);
  expect(status.run).toMatchObject({
    state: 'failed',
    message: 'The update command exited with code 3: npm error synthetic install failure',
  });
  expect(status.currentVersion).toBe('2.1.238');
});

test('reports an update that left the old version in place', async () => {
  await writeNpm({ latest: '2.1.300', installVersion: '2.1.238' });
  const updates = service();
  await updates.startUpdate();
  expect((await settled(updates)).run).toMatchObject({
    state: 'unchanged',
    message: 'The update command finished, but Synthetic CLI still reports 2.1.238.',
  });
});

test('skips the installer when the CLI is already current', async () => {
  const npm = await writeNpm({ latest: '2.1.238' });
  const updates = service();
  await updates.startUpdate();
  expect((await settled(updates)).run).toMatchObject({
    state: 'succeeded', message: 'Synthetic CLI 2.1.238 is already the latest version.',
  });
  expect((await npm.calls()).some((call) => call.startsWith('install'))).toBe(false);
  expect(updated).toBe(0);
});

test('starts one run for concurrent requests', async () => {
  const npm = await writeNpm({ latest: '2.1.300' });
  const updates = service();
  const [first, second] = await Promise.all([updates.startUpdate(), updates.startUpdate()]);
  expect(first.run.state).toBe('running');
  expect(second.run.state).toBe('running');
  await settled(updates);
  expect((await npm.calls()).filter((call) => call.startsWith('install'))).toHaveLength(1);
});

test('rejects updates that Garcon cannot run', async () => {
  const bundled = service({ target: async () => ({ command: cli.launcher, bundled: true }) });
  const bundledStatus = await bundled.status({ refresh: false });
  expect(bundledStatus).toMatchObject({ installMethod: 'bundled', currentVersion: '2.1.238', canUpdate: false });
  expect(await bundled.startUpdate().catch((error: unknown) => error)).toMatchObject({ code: 'OPERATION_UNSUPPORTED' });

  // Without npm on PATH the update can only be run by hand.
  const manual = service();
  const status = await manual.status({ refresh: false });
  expect(status).toMatchObject({ installMethod: 'npm', canUpdate: false });
  const failure = await manual.startUpdate().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AgentIntegrationError);
  expect((failure as AgentIntegrationError).code).toBe('OPERATION_UNSUPPORTED');
  expect((failure as Error).message).toContain('npm install -g --prefix');
});

test('reports a missing CLI', async () => {
  const status = await service({ target: async () => ({ command: 'synthetic-missing-cli', bundled: false }) }).status({ refresh: false });
  expect(status).toMatchObject({
    installMethod: 'missing', currentVersion: null, advisory: 'unknown', canUpdate: false,
    message: 'Synthetic CLI (synthetic-missing-cli) was not found on PATH.',
  });
});

test('keeps the end of long installer output and names the error it ends with', async () => {
  const warnings = Array.from({ length: 400 }, (_, index) => `npm warn deprecated synthetic-package-${index}@1.0.0`).join('\n');
  await fixture.writeScript(path.join(fixture.bin, 'npm'), `
case "$1" in
  view) echo '"2.1.300"' ;;
  install)
    printf '%s\\n' ${JSON.stringify(warnings)} >&2
    echo "npm error code EACCES" >&2
    printf 'progress %.0s' $(seq 1 2000)
    exit 243 ;;
esac`);
  const updates = service();
  await updates.startUpdate();
  const status = await settled(updates);
  expect(status.run).toMatchObject({
    state: 'failed',
    message: 'The update command exited with code 243: npm error code EACCES',
  });
  expect(status.run.output!.length).toBeLessThanOrEqual(10_000);
  expect(status.run.output!.endsWith('npm error code EACCES')).toBe(true);
});

test('bounds a failure message drawn from one long output line', async () => {
  await fixture.writeScript(path.join(fixture.bin, 'npm'), `
case "$1" in
  view) echo '"2.1.300"' ;;
  install)
    printf 'error: %s\\n' "$(printf 'x%.0s' $(seq 1 6000))" >&2
    exit 1 ;;
esac`);
  const updates = service();
  await updates.startUpdate();
  const status = await settled(updates);
  expect(status.run.state).toBe('failed');
  expect(status.run.message!.length).toBeLessThanOrEqual(500);
  expect(parseAgentCliUpdateStatus(JSON.parse(JSON.stringify(status)))).not.toBeNull();
});

test('reports the snapshot taken before a run while the installer runs', async () => {
  await writeNpm({ latest: '2.1.300' });
  const gate = path.join(fixture.root, 'release-install');
  const npm = path.join(fixture.bin, 'npm');
  const original = await readFile(npm, 'utf8');
  await fixture.writeScript(npm, original.replace('#!/bin/sh\n', '').replace('  install)\n', `  install)\n    while [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.02; done\n`));
  const updates = service();
  const started = await updates.startUpdate();
  expect(started).toMatchObject({ currentVersion: '2.1.238', advisory: 'behind-latest', run: { state: 'running' } });
  const during = await updates.status({ refresh: false });
  expect(during).toMatchObject({ currentVersion: '2.1.238', run: { state: 'running' } });
  await writeFile(gate, 'release');
  expect((await settled(updates)).run.state).toBe('succeeded');
});

test('shares one inspection between concurrent status reads', async () => {
  const calls = path.join(fixture.root, 'versions.log');
  await fixture.writeScript(cli.real, `echo probe >> ${JSON.stringify(calls)}; cat ${JSON.stringify(cli.versionFile)}`);
  await writeNpm({ latest: '2.1.300' });
  const updates = service();
  await Promise.all([updates.status({ refresh: false }), updates.status({ refresh: false })]);
  expect((await readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(1);
});

test('reports an unknown latest version when the lookup cannot run', async () => {
  // An npm on PATH that the kernel cannot execute.
  await writeFile(path.join(fixture.bin, 'npm'), new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
  await chmod(path.join(fixture.bin, 'npm'), 0o755);
  const status = await service().status({ refresh: false });
  expect(status).toMatchObject({ currentVersion: '2.1.238', latestVersion: null, advisory: 'unknown' });
});

test('reads the binary again when a run finishes during a slow status read', async () => {
  const marker = path.join(fixture.root, 'first-probe');
  // The first probe reads the old version, then stalls past the whole run.
  await fixture.writeScript(cli.real, `v=$(cat ${JSON.stringify(cli.versionFile)}); if [ ! -f ${JSON.stringify(marker)} ]; then touch ${JSON.stringify(marker)}; sleep 1.5; fi; echo "$v"`);
  await writeNpm({ latest: '2.1.300' });
  const updates = service();
  const read = updates.status({ refresh: false });
  await Bun.sleep(200);
  await updates.startUpdate();
  expect((await settled(updates)).run.state).toBe('succeeded');
  expect(await read).toMatchObject({ currentVersion: '2.1.300', run: { state: 'succeeded' } });
});
