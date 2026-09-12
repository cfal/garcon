import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_NODE_REPLAY } from '../server/execution-node/replay-cache.js';
import { createNodeWorkerWorkingDirectory, NODE_WORKER_BUN_OPTIONS } from '../server/execution-node/worker/launch.js';
import { NodeWorkerPeer } from '../server/execution-node/worker/peer.js';
import { prepareNodeInstanceEnvironments } from '../server/execution-node/worker/environment.js';

export async function smokeNodeWorkers(commandForRole) {
  const storage = await mkdtemp(path.join(homedir(), 'garcon-worker-smoke-'));
  const marker = path.join(storage, 'unexpected-preload');
  const preload = path.join(storage, 'preload.ts');
  try {
    await writeFile(preload, `await Bun.write(${JSON.stringify(marker)}, 'unexpected'); process.exit(2);`);
    await writeFile(path.join(storage, '.env'), 'SYNTHETIC_DOTENV_SECRET=must-not-load\n');
    await writeFile(path.join(storage, 'bunfig.toml'), `preload = [${JSON.stringify(preload)}]\n`);
    for (const role of ['session', 'instance']) {
      const directory = await createNodeWorkerWorkingDirectory(storage);
      const child = Bun.spawn(commandForRole(role), { cwd: directory.path,
        env: { PATH: '/usr/bin:/bin', HOME: storage, BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS },
        stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', timeout: 10_000 });
      const peer = new NodeWorkerPeer(child, { role, signal: AbortSignal.timeout(5_000), validate() {}, failed() {} });
      try {
        const pid = await peer.hello;
        if (pid !== child.pid || (await readdir(directory.path)).length !== 0 || existsSync(marker)) throw new Error('Worker inert startup failed');
        if (process.platform === 'linux' && (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim()) throw new Error('Inert worker created a child');
        peer.closeInput();
        if (await child.exited !== 0) throw new Error('Worker did not exit cleanly on EOF');
      } finally {
        peer.closeInput(); child.kill(); await child.exited; await directory.dispose();
      }
    }
    await smokeConfiguredInstance(commandForRole('instance'), storage, preload, marker);
    const directory = await createNodeWorkerWorkingDirectory(storage);
    const child = Bun.spawn(commandForRole('session'), { cwd: directory.path,
      env: { PATH: '/usr/bin:/bin', HOME: storage, BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS, SYNTHETIC_PARENT_SECRET: 'must-not-inherit' },
      stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', timeout: 15_000 });
    const peer = new NodeWorkerPeer(child, { role: 'session', signal: AbortSignal.timeout(10_000), validate() {}, failed() {} });
    try {
      const pid = await peer.hello;
      const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node-boot', logicalSessionId: 'synthetic-session' };
      const instance = { id: 'synthetic-instance', agentId: 'direct-anthropic-compatible', label: 'Synthetic',
        homeDirectory: path.join(storage, 'synthetic-home'), environment: {}, workspaceIds: ['synthetic-workspace'], maxOperations: 1 };
      const manifests = await peer.configure(session, 1, { role: 'session', nodeId: 'synthetic-node', storageDirectory: storage,
        instances: [instance], workspaces: [{ id: 'synthetic-workspace', projectPath: storage }], replay: DEFAULT_NODE_REPLAY });
      if (manifests.length !== 1 || manifests[0].instanceId !== instance.id || existsSync(marker)) throw new Error('Worker instance configuration failed');
      const children = process.platform === 'linux'
        ? (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number) : [];
      if (process.platform === 'linux' && children.length !== 1) throw new Error('Worker did not isolate its instance');
      await peer.admit(1);
      await smokeExecution(peer, instance.id);
      await smokeServices(peer, instance.id, session, 'session');
      peer.closeInput();
      if (await child.exited !== 0 || children.some((childPid) => existsSync(`/proc/${childPid}`))) throw new Error('Worker instance cleanup failed');
    } finally {
      peer.closeInput(); child.kill(); await child.exited; await directory.dispose();
    }
  } finally { await rm(storage, { recursive: true, force: true }); }
}

async function smokeConfiguredInstance(command, storage, preload, marker) {
  const directory = await createNodeWorkerWorkingDirectory(storage);
  // The compiled bunfig mitigation must be exercised in the actual cwd; home-level files do not trigger Bun autoloading.
  await writeFile(path.join(directory.path, 'bunfig.toml'), `preload = [${JSON.stringify(preload)}]\n`);
  const instance = { id: 'synthetic-preload-instance', agentId: 'direct-anthropic-compatible', label: 'Synthetic',
    homeDirectory: path.join(storage, 'synthetic-preload-home'), environment: {}, workspaceIds: ['synthetic-workspace'], maxOperations: 1 };
  const signal = AbortSignal.timeout(10_000);
  const environments = await prepareNodeInstanceEnvironments([instance], signal);
  const child = Bun.spawn(command, { cwd: directory.path,
    env: { ...environments.get(instance.id).values, BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS },
    stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', timeout: 15_000 });
  const peer = new NodeWorkerPeer(child, { role: 'instance', signal, validate() {}, failed() {} });
  try {
    await peer.hello;
    const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node-boot', logicalSessionId: 'synthetic-session' };
    const manifests = await peer.configure(session, 1, { role: 'instance', nodeId: 'synthetic-node', storageDirectory: storage,
      instance, workspaces: [{ id: 'synthetic-workspace', projectPath: storage }] });
    if (manifests.length !== 1 || manifests[0].instanceId !== instance.id || existsSync(marker)) throw new Error('Worker loaded cwd bunfig');
    await peer.admit(1);
    await smokeExecution(peer, instance.id);
    await smokeServices(peer, instance.id, session, 'instance');
    peer.closeInput();
    if (await child.exited !== 0) throw new Error('Configured worker did not exit cleanly');
  } finally {
    peer.closeInput(); child.kill(); await child.exited; await directory.dispose();
  }
}

async function smokeExecution(peer, instanceId) {
  const signal = AbortSignal.timeout(5_000);
  const execution = peer.execution(instanceId, 1);
  const prepared = await execution.call({ method: 'prepare',
    location: { nodeId: 'synthetic-node', instanceId, workspaceId: 'synthetic-workspace' },
    request: { kind: 'start', chatId: '1789000000000001', runId: 'synthetic-run',
      configuration: { model: 'synthetic-model', endpoint: null, settings: null } } }, signal);
  if (prepared.kind !== 'prepared') throw new Error('Worker execution preparation failed');
  const released = await execution.call({ method: 'release', identity: prepared.ticket.identity }, signal);
  const status = await execution.call({ method: 'status', identity: prepared.ticket.identity }, signal);
  if (released.kind !== 'released' || status.kind !== 'status' || status.receipt?.phase !== 'released') throw new Error('Worker execution release failed');
}

async function smokeServices(peer, instanceId, session, role) {
  const signal = AbortSignal.timeout(5_000);
  const service = peer.service(1);
  const stream = { ...session, streamId: 'synthetic-service-stream' };
  const installed = await service.call({ method: 'install-output', instanceId, stream }, signal);
  if (installed.kind !== 'output-installed') throw new Error('Worker output installation failed');
  await peer.forward({ type: 'node-worker-output-retired', version: 1, instanceId, stream }, signal).drained;
  const permission = await service.call({ method: 'permission', command: { method: 'permission-status', permission: {
    stream, runId: 'synthetic-run', handle: 'synthetic-absent-handle', permissionOccurrenceId: '00000000-0000-4000-8000-000000000001',
  } } }, signal);
  if (permission.kind !== 'permission-result' || permission.result.kind !== 'permission' || permission.result.receipt !== null) {
    throw new Error('Worker permission routing failed');
  }
  if (role !== 'session') return;
  const recovery = await service.call({ method: 'begin-output-recovery' }, signal);
  if (recovery.kind !== 'output-recovery') throw new Error('Worker output recovery failed');
  const replay = await service.call({ method: 'replay-output', generation: recovery.generation, cursors: [{ stream, afterSequence: 0 }] }, signal);
  if (replay.kind !== 'output-replayed' || replay.ranges.length !== 1 || replay.ranges[0].type !== 'node-replay-ready'
    || replay.ranges[0].throughSequence !== 0) throw new Error('Worker retired output replay failed');
  const resumed = await service.call({ method: 'resume-output', generation: recovery.generation }, signal);
  if (resumed.kind !== 'output-live' || !resumed.live) throw new Error('Worker live output admission failed');
}
