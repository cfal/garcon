import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Subprocess } from 'bun';
import { NodeSessionCoordinator, type NodeHostedConnection } from '../../../server/execution-node/session-coordinator.js';
import { NodeSessionMarkerFile } from '../../../server/execution-node/systemd/session-marker.js';
import { NodeWorkerPeer } from '../../../server/execution-node/worker/peer.js';
import { createNodeWorkerWorkingDirectory, NODE_WORKER_BUN_OPTIONS, nodeWorkerCommand } from '../../../server/execution-node/worker/launch.js';
import { DEFAULT_NODE_REPLAY } from '../../../server/execution-node/replay-cache.js';
import { NODE_CONTROLLER_LEASE_MS } from '../../../server/execution-node/supervisor.js';

const available = process.platform === 'linux'
  && spawnSync('systemctl', ['--user', 'is-system-running'], { stdio: 'ignore', timeout: 2000 }).status === 0;

describe.skipIf(!available)('execution-node supervised coordinator', () => {
  test('reconnect preserves the real worker tree, recovery gates admission, and lease expiry proves complete cleanup', async () => {
    const storage = await mkdtemp(path.join(homedir(), 'garcon-session-coordinator-'));
    const directory = await createNodeWorkerWorkingDirectory(storage);
    const nodeId = `synthetic-${randomUUID()}`;
    const marker = await NodeSessionMarkerFile.acquire({ runtimeDirectory: storage, controllerId: 'synthetic-controller', nodeId,
      onCompromised() { throw new Error('Synthetic marker lock lost'); } });
    const processes = new Map<object, Subprocess<'pipe', 'pipe', 'ignore'>>();
    let elapsedMs = 0;
    const coordinator = new NodeSessionCoordinator({
      configuration: { role: 'session', nodeId, storageDirectory: storage,
        instances: ['synthetic-first', 'synthetic-second'].map((id) => ({ id, agentId: 'direct-anthropic-compatible', label: id,
          homeDirectory: path.join(storage, id), environment: {}, workspaceIds: ['synthetic-workspace'], maxOperations: 1 })),
        workspaces: [{ id: 'synthetic-workspace', projectPath: storage }], replay: DEFAULT_NODE_REPLAY },
      host: { nodeId, marker, command: nodeWorkerCommand('session'),
        launchOptions: { workingDirectory: directory.path, environment: { BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS } },
        spawn(launch) {
          const child = Bun.spawn([...launch.argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
          const hostProcess = { exited: child.exited, closeInput() { void child.stdin.end(); }, kill() { child.kill(); } };
          processes.set(hostProcess, child);
          return hostProcess;
        } },
      supervisor: { clock: { read: () => ({ elapsedMs, discontinuity: false }) } },
      createPeer(host, options) {
        const child = processes.get(host.process);
        if (!child) throw new Error('Synthetic worker process missing');
        return new NodeWorkerPeer(child, options);
      },
      received() { throw new Error('Unexpected synthetic application frame'); },
    });
    const recover = async (connection: NodeHostedConnection) => {
      const attempt = coordinator.beginRecovery(connection);
      const service = coordinator.peer(connection).service(connection.connectionId);
      const begin = await service.call({ method: 'begin-output-recovery' }, connection.lease.signal);
      if (begin.kind !== 'output-recovery') throw new Error('Synthetic recovery did not begin');
      expect(await service.call({ method: 'resume-output', generation: begin.generation }, connection.lease.signal))
        .toEqual({ kind: 'output-live', live: true });
      expect(await coordinator.completeRecovery(connection, attempt)).toBe(true);
      coordinator.supervisor.assertAdmission(connection.lease);
    };
    try {
      await coordinator.initialize();
      const first = coordinator.open('synthetic-controller-boot');
      const manifests = await first.ready;
      expect(manifests.map((entry) => entry.instanceId)).toEqual(['synthetic-first', 'synthetic-second']);
      const identity = (await marker.read())?.identity;
      if (!identity) throw new Error('Synthetic containment identity missing');
      const peer = coordinator.peer(first);
      expect(await peer.hello).toBe(identity.mainPid);
      const children = (await readFile(`/proc/${identity.mainPid}/task/${identity.mainPid}/children`, 'utf8')).trim().split(/\s+/).map(Number);
      expect(children).toHaveLength(2);
      for (const pid of [identity.mainPid, ...children]) {
        expect(await readFile(`/proc/${pid}/cgroup`, 'utf8')).toBe(`0::${identity.controlGroup}\n`);
      }
      expect(() => coordinator.supervisor.assertAdmission(first.lease)).toThrow();
      await recover(first);
      await coordinator.disconnect(first);
      expect(first.lease.signal.aborted).toBe(true);
      expect(first.lease.authoritySignal.aborted).toBe(false);
      const replacement = coordinator.attach(first.lease.session);
      expect(await replacement.ready).toEqual(manifests);
      expect(coordinator.peer(replacement)).toBe(peer);
      expect(processes.size).toBe(1);
      expect((await marker.read())?.identity).toEqual(identity);
      expect(() => coordinator.supervisor.assertAdmission(replacement.lease)).toThrow();
      await coordinator.disconnect(first);
      await recover(replacement);
      await coordinator.disconnect(replacement);
      elapsedMs = NODE_CONTROLLER_LEASE_MS;
      coordinator.supervisor.poll();
      expect(replacement.lease.authoritySignal.aborted).toBe(true);
      expect(await coordinator.supervisor.retryCleanup()).toBe(true);
      expect(await marker.read()).toBeNull();
      for (const pid of [identity.mainPid, ...children]) expect(existsSync(`/proc/${pid}`)).toBe(false);
      expect(existsSync(`/sys/fs/cgroup${identity.controlGroup}`)).toBe(false);
      const next = coordinator.open('synthetic-next-controller-boot');
      expect(next.lease.session.logicalSessionId).not.toBe(first.lease.session.logicalSessionId);
      await next.ready;
      await recover(next);
      expect(processes.size).toBe(2);
    } finally {
      const cleaned = await coordinator.shutdown();
      await marker.release();
      if (cleaned) await rm(storage, { recursive: true, force: true });
      expect(cleaned).toBe(true);
    }
  }, 30_000);
});
