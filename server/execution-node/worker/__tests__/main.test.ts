import { DEFAULT_NODE_EXECUTABLE_SEARCH_PATH } from '../configuration.js';
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { NodeWorkerPeer } from '../peer.js';
import { createNodeWorkerWorkingDirectory, NODE_WORKER_BUN_OPTIONS, nodeWorkerCommand } from '../launch.js';
import { readNodeWorkerFrames } from '../framing.js';
import { MAX_NODE_WORKER_LIFECYCLE_BYTES, parseNodeWorkerChildText } from '../protocol.js';
import { configuration, session } from './lifecycle-fixture.js';
import { prepareNodeInstanceEnvironments } from '../environment.js';

for (const role of ['session', 'instance'] as const) {
  test(`${role} entry emits only an inert hello and exits on EOF without creating resources`, async () => {
    const storage = await mkdtemp(path.join(homedir(), 'garcon-worker-main-'));
    const directory = await createNodeWorkerWorkingDirectory(storage);
    const child = Bun.spawn(nodeWorkerCommand(role), { cwd: directory.path, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: { PATH: '/usr/bin:/bin', BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS }, timeout: 5000 });
    const frames = readNodeWorkerFrames(child.stdout, MAX_NODE_WORKER_LIFECYCLE_BYTES, AbortSignal.timeout(5000));
    const diagnostics = new Response(child.stderr).text();
    try {
      const hello = await frames.next();
      expect(hello.done).toBe(false);
      expect(parseNodeWorkerChildText(hello.value!)).toEqual({ type: 'node-worker-hello', version: 1, role, pid: child.pid });
      if (process.platform === 'linux') expect(await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).toBe('');
      expect(await readdir(directory.path)).toEqual([]);
      expect(await readdir(storage)).toEqual([path.basename(directory.path)]);
      await child.stdin.end();
      expect(await child.exited).toBe(0);
      expect((await frames.next()).done).toBe(true);
      expect(await diagnostics).toBe('');
    } finally {
      child.kill(); await child.exited; await frames.return(undefined);
      await rm(storage, { recursive: true, force: true });
    }
  });
}

test.each([['--help'], ['--internal-node-instance-worker'], ['unexpected']])('private worker rejects extra argv %j before ordinary startup', async (extra) => {
  const child = Bun.spawn([...nodeWorkerCommand('session'), ...extra], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
  const output = new Response(child.stdout).text();
  const diagnostics = new Response(child.stderr).text();
  expect(await child.exited).toBe(2);
  expect(await output).toBe('');
  expect(await diagnostics).toBe('');
});

test('source instance startup ignores dotenv and bunfig in its cwd, home, and storage parent', async () => {
  const storage = await mkdtemp(path.join(homedir(), 'garcon-worker-autoload-'));
  const directory = await createNodeWorkerWorkingDirectory(storage);
  const instance = { ...configuration().instances[0]!, agentId: 'direct-anthropic-compatible',
    homeDirectory: path.join(storage, 'synthetic-home'), environment: {} };
  const signal = AbortSignal.timeout(10_000);
  const environment = (await prepareNodeInstanceEnvironments([instance], signal, DEFAULT_NODE_EXECUTABLE_SEARCH_PATH)).get(instance.id)!;
  const marker = path.join(storage, 'unexpected-preload');
  const preload = path.join(storage, 'preload.ts');
  await writeFile(preload, `await Bun.write(${JSON.stringify(marker)}, 'unexpected'); console.log('unexpected preload');`);
  for (const location of [storage, directory.path, instance.homeDirectory]) {
    await writeFile(path.join(location, '.env'), 'SYNTHETIC_DOTENV_SECRET=must-not-load\n');
    await writeFile(path.join(location, 'bunfig.toml'), `preload = [${JSON.stringify(preload)}]\n`);
  }
  const child = Bun.spawn(nodeWorkerCommand('instance'), { cwd: directory.path,
    env: { ...environment.values, BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', timeout: 15_000 });
  const diagnostics = new Response(child.stderr).text();
  const peer = new NodeWorkerPeer(child, { role: 'instance', signal, validate() {}, failed() {} });
  try {
    expect(await peer.hello).toBe(child.pid);
    const ready = await peer.configure(session, 1, { role: 'instance', nodeId: 'synthetic-node', storageDirectory: storage, executableSearchPath: DEFAULT_NODE_EXECUTABLE_SEARCH_PATH, instance,
      workspaces: [{ id: 'synthetic-workspace', projectPath: storage }] });
    expect(ready[0]?.instanceId).toBe(instance.id);
    expect(existsSync(marker)).toBe(false);
    peer.closeInput();
    expect(await child.exited).toBe(0);
    expect(await diagnostics).toBe('');
  } finally {
    peer.closeInput(); child.kill(); await child.exited;
    await rm(storage, { recursive: true, force: true });
  }
}, 15_000);

test('session runtime hosts two same-provider instances in separate children and cleans them on EOF', async () => {
  const storage = await mkdtemp(path.join(homedir(), 'garcon-worker-instances-'));
  const directory = await createNodeWorkerWorkingDirectory(storage);
  const child = Bun.spawn(nodeWorkerCommand('session'), { cwd: directory.path, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin', BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS, SYNTHETIC_PARENT_SECRET: 'synthetic-private-value' }, timeout: 15_000 });
  const diagnostics = new Response(child.stderr).text();
  const failures: string[] = [];
  const peer = new NodeWorkerPeer(child, { role: 'session', signal: AbortSignal.timeout(10_000), validate() {}, failed(error) { failures.push(error.code); } });
  let children: number[] = [];
  try {
    expect(await peer.hello).toBe(child.pid);
    const original = configuration();
    const instances = ['synthetic-personal', 'synthetic-work'].map((id) => ({ ...original.instances[0]!, id,
      agentId: 'direct-anthropic-compatible', homeDirectory: path.join(storage, id), environment: {} }));
    const ready = await peer.configure(session, 1, { ...original, storageDirectory: storage, instances,
      workspaces: [{ id: 'synthetic-workspace', projectPath: storage }] });
    expect(ready.map((manifest) => manifest.instanceId)).toEqual(instances.map((instance) => instance.id));
    expect(ready.every((manifest) => manifest.descriptor.id === 'direct-anthropic-compatible')).toBe(true);
    expect(ready.every((manifest) => Object.entries(manifest.facets).every(([facet, present]) => present === (facet === 'catalog' || facet === 'auth' ? true : null)))).toBe(true);
    for (const instance of instances) expect(existsSync(path.join(storage, 'agent-data', 'instances', instance.id))).toBe(true);
    expect(existsSync(path.join(storage, 'agent-data', 'direct-anthropic-compatible'))).toBe(false);
    if (process.platform === 'linux') {
      children = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/).map(Number);
      expect(children).toHaveLength(2);
      const homes: string[] = [];
      for (const pid of children) {
        const entries = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0');
        expect(entries.some((entry) => entry.startsWith('SYNTHETIC_PARENT_SECRET='))).toBe(false);
        homes.push(entries.find((entry) => entry.startsWith('HOME='))!);
      }
      expect(homes.sort()).toEqual(instances.map((instance) => `HOME=${instance.homeDirectory}`).sort());
    }
    await peer.admit(1);
    await peer.disconnect(1);
    await peer.attach(2);
    await peer.admit(2);
    expect(failures).toEqual([]);
    peer.closeInput();
    expect(await child.exited).toBe(0);
    for (const pid of children) expect(existsSync(`/proc/${pid}`)).toBe(false);
    expect((await readdir(storage)).filter((entry) => entry.startsWith('.worker-'))).toEqual([path.basename(directory.path)]);
    expect(await diagnostics).toBe('');
  } finally {
    peer.closeInput(); child.kill(); await child.exited;
    await rm(storage, { recursive: true, force: true });
  }
}, 15_000);
