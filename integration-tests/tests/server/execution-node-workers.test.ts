import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Subprocess } from 'bun';
import { NodeSessionHostOwner } from '../../../server/execution-node/systemd/session-host.js';
import { NodeSessionMarkerFile } from '../../../server/execution-node/systemd/session-marker.js';
import { NodeWorkerPeer } from '../../../server/execution-node/worker/peer.js';
import { createNodeWorkerWorkingDirectory, NODE_WORKER_BUN_OPTIONS, nodeWorkerCommand } from '../../../server/execution-node/worker/launch.js';
import { DEFAULT_NODE_REPLAY } from '../../../server/execution-node/replay-cache.js';

const available = process.platform === 'linux' && spawnSync('systemctl', ['--user', 'is-system-running'], { stdio: 'ignore', timeout: 2000 }).status === 0;

describe.skipIf(!available)('execution-node private worker composition', () => {
  test('one confirmed session unit contains all instance children and cleanup removes the complete group', async () => {
    const storage = await mkdtemp(path.join(homedir(), 'garcon-worker-containment-'));
    const directory = await createNodeWorkerWorkingDirectory(storage);
    const nodeId = `synthetic-${randomUUID()}`;
    const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-boot', logicalSessionId: 'synthetic-session' };
    const marker = await NodeSessionMarkerFile.acquire({ runtimeDirectory: storage, controllerId: 'synthetic-controller', nodeId, onCompromised() {} });
    const processPort: { child: Subprocess<'pipe', 'pipe', 'ignore'> | null } = { child: null };
    const owner = new NodeSessionHostOwner({ nodeId, marker, command: nodeWorkerCommand('session'),
      launchOptions: { workingDirectory: directory.path, environment: { BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS } },
      spawn(launch) {
        const child = processPort.child = Bun.spawn([...launch.argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
        return { exited: child.exited, closeInput() { void child.stdin.end(); }, kill() { child.kill('SIGKILL'); } };
      }, exited() {} });
    let peer: NodeWorkerPeer | null = null;
    let host: Awaited<ReturnType<NodeSessionHostOwner['launch']>> | null = null;
    try {
      await owner.reconcile();
      host = await owner.launch();
      if (!processPort.child) throw new Error('Worker process was not captured');
      peer = new NodeWorkerPeer(processPort.child, { role: 'session', signal: AbortSignal.timeout(15_000), validate() {}, failed() {} });
      const workerPid = await peer.hello;
      expect(await readFile(`/proc/${workerPid}/task/${workerPid}/children`, 'utf8')).toBe('');
      expect((await marker.read())?.identity).toBeNull();
      const identity = await owner.confirm(host);
      expect(identity.mainPid).toBe(workerPid);
      expect((await marker.read())?.identity).toEqual(identity);
      owner.bind(host, session);
      const instances = ['synthetic-first', 'synthetic-second'].map((id) => ({ id, agentId: 'direct-anthropic-compatible', label: id,
        homeDirectory: path.join(storage, id), environment: {}, workspaceIds: ['synthetic-workspace'], maxOperations: 1 }));
      const ready = await peer.configure(session, 1, { role: 'session', nodeId, storageDirectory: storage, instances,
        workspaces: [{ id: 'synthetic-workspace', projectPath: storage }], replay: DEFAULT_NODE_REPLAY });
      expect(ready.map((manifest) => manifest.instanceId)).toEqual(instances.map((instance) => instance.id));
      const children = (await readFile(`/proc/${workerPid}/task/${workerPid}/children`, 'utf8')).trim().split(/\s+/).map(Number);
      expect(children).toHaveLength(2);
      for (const pid of [workerPid, ...children]) expect(await readFile(`/proc/${pid}/cgroup`, 'utf8')).toBe(`0::${identity.controlGroup}\n`);
      expect(await readFile(`/proc/${process.pid}/cgroup`, 'utf8')).not.toContain(identity.controlGroup);
      await peer.admit(1);
      await owner.cleanup(session);
      host = null;
      expect(await marker.read()).toBeNull();
      for (const pid of [workerPid, ...children]) expect(existsSync(`/proc/${pid}`)).toBe(false);
      expect(existsSync(`/sys/fs/cgroup${identity.controlGroup}`)).toBe(false);
    } finally {
      peer?.closeInput();
      if (host) await owner.stop(host);
      await marker.release();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);
});
