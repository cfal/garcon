import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chooseSimulator, findSimulatorApp, validateSimulatorApp } from './ios-app.js';

const root = resolve(import.meta.dir, '..');
const app = findSimulatorApp(root);
await validateSimulatorApp(app, root);
const identifier = 'com.garconcloud.garcon';
const artifacts = resolve(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const log = [];

async function simctl(...args) {
  const child = Bun.spawn(['xcrun', 'simctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const code = await child.exited;
  const text = await output;
  log.push(`${args.join(' ')}\n${text}${await errors}`);
  if (code !== 0) throw new Error(`simctl ${args[0]} failed (${code})`);
  return text.trim();
}

const catalog = JSON.parse(await simctl('list', '--json'));
const { runtime, deviceType } = chooseSimulator(catalog);
let device;
try {
  device = await simctl('create', `Garcon-isolated-smoke-${process.pid}`, deviceType, runtime);
  await simctl('boot', device);
  await simctl('bootstatus', device, '-b');
  await simctl('install', device, app);
  for (const phase of ['cold-launch', 'relaunch']) {
    const launched = await simctl('launch', device, identifier);
    const pid = launched.match(/: (\d+)$/)?.[1];
    assert.ok(pid, `Missing process id: ${launched}`);
    // Checks for early exits without treating a successful launch command as a runtime pass.
    for (let tick = 0; tick < 5; tick++) {
      await Bun.sleep(1000);
      const processes = await simctl('spawn', device, 'launchctl', 'list');
      assert.ok(processes.split('\n').some(line => line.startsWith(`${pid}\t`) && line.includes(identifier)), 'Simulator app exited after launch');
    }
    await simctl('io', device, 'screenshot', resolve(artifacts, `ios-${phase}.png`));
    await simctl('terminate', device, identifier);
  }
  console.log('iOS simulator launch/relaunch passed. Screenshots require review; no login, navigation, or device claim.');
} finally {
  try {
    if (device) {
      try { await simctl('shutdown', device); } finally { await simctl('delete', device); }
    }
  } finally { await Bun.write(resolve(artifacts, 'ios-launch.log'), log.join('\n')); }
}
