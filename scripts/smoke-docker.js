#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const image = process.argv[2];
if (!image || process.argv.length !== 3) {
  throw new Error('Usage: bun scripts/smoke-docker.js <image>');
}

const prefix = `garcon-smoke-${crypto.randomUUID()}`;
const network = `${prefix}-network`;
const controller = `${prefix}-controller`;
const dialer = `${prefix}-dialer`;
const listener = `${prefix}-listener`;
const containers = new Set();
const volumes = new Set();
const directory = await mkdtemp(path.join(homedir(), '.garcon-docker-smoke-'));

async function docker(args, { input, allowFailure = false } = {}) {
  const child = Bun.spawn(['docker', ...args], {
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'pipe', stderr: 'pipe', timeout: 90_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`Docker ${args[0]} failed (${exitCode}): ${stderr}`);
  }
  return { stdout, stderr, exitCode };
}

function cli(container, args, options) {
  const command = ['exec'];
  if (options?.input !== undefined) command.push('-i');
  command.push('--workdir', '/projects', container, 'garcon-cli', ...args);
  return docker(command, options);
}

async function jsonCli(container, args, options) {
  const { stdout } = await cli(container, [...args, '--json'], options);
  return JSON.parse(stdout);
}

async function startContainer(container, command = [], options = []) {
  containers.add(container);
  const volume = `${container}-data`;
  volumes.add(volume);
  await docker(['run', '--detach', '--init', '--name', container, '--network', network,
    '--mount', `type=volume,source=${volume},target=/home/garcon/.garcon`,
    ...options, image, ...command]);
}

async function waitForCli(container) {
  const deadline = Date.now() + 60_000;
  let result;
  do {
    result = await cli(container, ['executor', 'list', '--json'], { allowFailure: true });
    if (result.exitCode === 0) return;
    const running = await docker(['inspect', '--format', '{{.State.Running}}', container]);
    assert.equal(running.stdout.trim(), 'true', `${container} exited before readiness`);
    await Bun.sleep(250);
  } while (Date.now() < deadline);
  throw new Error(`CLI did not become ready: ${result.stderr}`);
}

async function verifyExecutorAccessAndRestart(id, container) {
  const ready = await jsonCli(controller, ['executor', 'wait', id, '--ready', '--timeout', '60']);
  assert.equal(ready.projectBasePath, '/projects');
  assert.equal(ready.allowControllerCli, false);
  const denied = await cli(container, ['executor', 'list', '--json'], { allowFailure: true });
  assert.notEqual(denied.exitCode, 0, 'Worker CLI must require its controller-side grant');
  assert.match(denied.stderr, /CLI context unavailable \(HTTP 403\)/);

  await jsonCli(controller, ['executor', 'update', id, '--allow-controller-cli', 'true']);
  await waitForCli(container);
  const catalog = await jsonCli(container, ['list', 'agents']);
  const selected = await jsonCli(controller, ['list', 'agents', '--executor', id]);
  assert.deepEqual(catalog, selected);
  assert.ok(catalog.agents.length > 0, 'Packaged provider integrations must be discoverable');
  const snapshot = await jsonCli(container, ['executor', 'show', id]);
  assert.equal(snapshot.allowExecutorManagement, false);

  await docker(['restart', '--time', '20', container]);
  await waitForCli(container);
  const restarted = await jsonCli(controller, ['executor', 'wait', id, '--ready', '--timeout', '60']);
  assert.equal(restarted.projectBasePath, '/projects');
  assert.notEqual(restarted.instanceId, ready.instanceId);
}

async function verifyControllerStartup() {
  await startContainer(controller);
  await waitForCli(controller);
  const version = await cli(controller, ['--version']);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);
  const help = await cli(controller, ['--help']);
  assert.match(help.stdout, /Usage:\s+garcon-cli/);
  const uid = await docker(['exec', controller, 'id', '-u']);
  assert.notEqual(uid.stdout.trim(), '0');
  const local = await jsonCli(controller, ['--runtime', 'controller', 'executor', 'show', 'local']);
  assert.equal(local.projectBasePath, '/projects');
  await docker(['exec', controller, 'bun', '-e', String.raw`
    const root = await fetch('http://127.0.0.1:8080/');
    const html = await root.text();
    const asset = html.match(/\/_app\/[^"'\s>]+/);
    if (!root.ok || !asset) throw new Error('Missing packaged web app');
    if (!(await fetch('http://127.0.0.1:8080' + asset[0])).ok) throw new Error('Missing web asset');
    if ((await fetch('http://127.0.0.1:8080/api/v1/preambles')).status !== 401) {
      throw new Error('Controller authentication must remain enabled');
    }
  `]);
  console.log('Controller: default startup, web assets, authentication, and CLI passed.');
}

async function verifyExecutorConnects() {
  const created = await jsonCli(controller, ['executor', 'create', '--label', 'Docker dialing worker',
    '--direction', 'executor-connects', '--no-tls', 'true',
    '--advertise-url', `ws://${controller}:8080/executor/{executorId}`]);
  await cli(controller, ['executor', 'connection', created.id, '--output', '/home/garcon/connection.txt']);
  const connectionFile = path.join(directory, 'connection.txt');
  await docker(['cp', `${controller}:/home/garcon/connection.txt`, connectionFile]);
  const connection = (await readFile(connectionFile, 'utf8')).trim();
  const envFile = path.join(directory, 'executor.env');
  await writeFile(envFile, `GARCON_CONTROLLER_URL=${connection}\n`, { mode: 0o600 });
  await startContainer(dialer, ['bun', 'server/main.ts', 'executor', '--project-base-dir', '/projects', '--no-tls'],
    ['--env-file', envFile, '--env', 'GARCON_RUNTIME=executor']);
  await verifyExecutorAccessAndRestart(created.id, dialer);
  console.log('Executor-connects: enrollment, CLI grant, target catalog, and restart passed.');
}

async function verifyControllerConnects() {
  const listenerCommand = ['bun', 'server/main.ts', 'executor', '--project-base-dir', '/projects',
    '--listen', '19781', '--bind-address', '0.0.0.0', '--no-tls'];
  const listenerOptions = ['--env', 'GARCON_RUNTIME=executor'];
  await startContainer(listener, listenerCommand, listenerOptions);
  const reveal = ['exec', listener, 'bun', '/app/server/main.ts', 'executor', 'connection-url',
    '--advertise-url', `ws://${listener}:19781/executor`, '--no-tls'];
  const deadline = Date.now() + 60_000;
  let credential;
  do {
    credential = await docker(reveal, { allowFailure: true });
    if (credential.exitCode === 0) break;
    await Bun.sleep(250);
  } while (Date.now() < deadline);
  assert.equal(credential.exitCode, 0, 'Listener credential must be available after startup');
  const listening = await jsonCli(controller, ['executor', 'create', '--label', 'Docker listening worker',
    '--direction', 'controller-connects', '--no-tls', 'true', '--connection-url', '-'],
    { input: credential.stdout });
  await verifyExecutorAccessAndRestart(listening.id, listener);
  const previousContainer = await docker(['inspect', '--format', '{{.Id}}', listener]);
  await docker(['stop', '--time', '20', listener]);
  await docker(['rm', listener]);
  await startContainer(listener, listenerCommand, listenerOptions);
  const replacementContainer = await docker(['inspect', '--format', '{{.Id}}', listener]);
  assert.notEqual(replacementContainer.stdout, previousContainer.stdout);
  await waitForCli(listener);
  await jsonCli(controller, ['executor', 'wait', listening.id, '--ready', '--timeout', '60']);
  const retained = await docker(reveal);
  assert.ok(retained.stdout === credential.stdout, 'Listener credential must survive container recreation');
  console.log('Controller-connects: enrollment, CLI grant, target catalog, and credential persistence across recreation passed.');
}

async function verifyControllerRestartAndShutdown() {
  await docker(['restart', '--time', '20', controller]);
  await waitForCli(controller);
  for (const container of [dialer, listener]) await waitForCli(container);
  const configured = await jsonCli(controller, ['executor', 'list']);
  assert.equal(configured.executors.filter(entry => entry.kind === 'remote').length, 2);
  for (const container of containers) {
    await docker(['stop', '--time', '20', container]);
    const stopped = await docker(['inspect', '--format', '{{.State.ExitCode}}', container]);
    assert.equal(stopped.stdout.trim(), '0', 'Packaged process must shut down gracefully');
  }
  console.log('Controller restart, worker rediscovery, and graceful shutdown passed.');
}

try {
  await docker(['network', 'create', '--internal', network]);
  await verifyControllerStartup();
  await verifyExecutorConnects();
  await verifyControllerConnects();
  await verifyControllerRestartAndShutdown();
  console.log(`Docker smoke passed: ${image}`);
} finally {
  for (const container of [...containers].reverse()) {
    await docker(['stop', '--time', '20', container], { allowFailure: true });
    await docker(['rm', '--force', container], { allowFailure: true });
  }
  for (const volume of volumes) await docker(['volume', 'rm', volume], { allowFailure: true });
  await docker(['network', 'rm', network], { allowFailure: true });
  await rm(directory, { recursive: true, force: true });
}
