import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseSystemdIdentity, type SystemdUnitIdentity } from '../../../server/execution-node/systemd/contracts.js';
import { runSystemdHelper } from '../../../server/execution-node/systemd/helper-process.js';
import { NodeSessionHostOwner } from '../../../server/execution-node/systemd/session-host.js';
import { NodeSessionMarkerFile, parseNodeSessionHostMarker } from '../../../server/execution-node/systemd/session-marker.js';
import { readNodeWorkerFrames } from '../../../server/execution-node/worker/framing.js';
import { createNodeWorkerWorkingDirectory, NODE_WORKER_BUN_OPTIONS, nodeWorkerCommand } from '../../../server/execution-node/worker/launch.js';
import { parseNodeWorkerChildText } from '../../../server/execution-node/worker/protocol.js';

const available = process.platform === 'linux' && spawnSync('systemctl', ['--user', 'is-system-running'], {
  stdio: 'ignore', timeout: 2000,
}).status === 0;

describe.skipIf(!available)('execution-node coordinator crash containment', () => {
  test.each(['launch-only', 'identified', 'configured'] as const)('SIGKILL retires the production %s worker and replacement reconciles its marker', async (phase) => {
    const runtimeDirectory = await mkdtemp(path.join(homedir(), 'garcon-coordinator-crash-'));
    const nodeId = `synthetic-${randomUUID()}`;
    const coordinator = Bun.spawn([process.execPath, `${import.meta.dir}/../../support/node-session-coordinator.ts`, runtimeDirectory, nodeId, phase], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
    });
    const diagnostics = new Response(coordinator.stderr).text();
    const frames = readNodeWorkerFrames(coordinator.stdout, 8192, AbortSignal.timeout(10_000));
    let marker: NodeSessionMarkerFile | null = null;
    let identity: SystemdUnitIdentity | null = null;
    try {
      const ready = await frames.next();
      if (ready.done) throw new Error(`Synthetic coordinator exited: ${await diagnostics}`);
      const announced: unknown = JSON.parse(ready.value);
      if (typeof announced !== 'object' || announced === null || !('identity' in announced) || !('markerPath' in announced)
        || typeof announced.markerPath !== 'string' || !('childPids' in announced) || !Array.isArray(announced.childPids)
        || !announced.childPids.every((pid) => Number.isSafeInteger(pid) && pid > 0)) throw new Error('Invalid synthetic coordinator announcement');
      identity = parseSystemdIdentity(announced.identity);
      if (!identity) throw new Error('Invalid synthetic containment identity');
      const before = parseNodeSessionHostMarker(JSON.parse(await readFile(announced.markerPath, 'utf8')));
      expect(before?.launch.launchId).toBe(identity.launchId);
      expect(before?.identity).toEqual(phase === 'launch-only' ? null : identity);
      expect(announced.childPids).toHaveLength(phase === 'configured' ? 2 : 0);
      const workerPids: number[] = [identity.mainPid, ...announced.childPids];
      for (const pid of workerPids) expect(await readFile(`/proc/${pid}/cgroup`, 'utf8')).toBe(`0::${identity.controlGroup}\n`);
      const coordinatorGroup = await readFile(`/proc/${coordinator.pid}/cgroup`, 'utf8');
      expect(coordinatorGroup).not.toContain(identity.controlGroup);
      await expect(NodeSessionMarkerFile.acquire({ runtimeDirectory, controllerId: 'synthetic-controller', nodeId, onCompromised() {} })).rejects.toThrow();

      coordinator.kill('SIGKILL');
      expect(await coordinator.exited).not.toBe(0);
      await Promise.all(workerPids.map(waitForExit));
      for (const pid of workerPids) expect(existsSync(`/proc/${pid}`)).toBe(false);
      // Simulates the stale-lock interval only after the exact owner has been killed and reaped.
      await utimes(path.join(path.dirname(announced.markerPath), '.coordinator.lock'), new Date(0), new Date(0));
      marker = await NodeSessionMarkerFile.acquire({ runtimeDirectory, controllerId: 'synthetic-controller', nodeId, onCompromised() {} });
      const directory = await createNodeWorkerWorkingDirectory(runtimeDirectory);
      const outputs: { stream: ReadableStream<Uint8Array> | null } = { stream: null };
      const owner = new NodeSessionHostOwner({ nodeId, marker,
        command: nodeWorkerCommand('session'),
        launchOptions: { workingDirectory: directory.path, environment: { BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS } },
        spawn(launch) {
          const child = Bun.spawn([...launch.argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
          outputs.stream = child.stdout;
          return { exited: child.exited, closeInput() { void child.stdin.end(); }, kill() { child.kill(); } };
        }, exited() {} });
      await expect(owner.launch()).rejects.toThrow();
      await owner.reconcile();
      expect(await marker.read()).toBeNull();
      expect(existsSync(`/sys/fs/cgroup${identity.controlGroup}`)).toBe(false);
      const unloaded = spawnSync('systemctl', ['--user', 'show', identity.unitName, '--property=LoadState', '--value'], {
        encoding: 'utf8', timeout: 2000,
      });
      expect(unloaded.stdout.trim()).toBe('not-found');
      const replacement = await owner.launch();
      try {
        expect(replacement.launch.identity.launchId).not.toBe(identity.launchId);
        if (!outputs.stream) throw new Error('Synthetic replacement stdout was not captured');
        const replacementFrames = readNodeWorkerFrames(outputs.stream, 1024, AbortSignal.timeout(5000));
        const hello = parseNodeWorkerChildText((await replacementFrames.next()).value!);
        const confirmed = await owner.confirm(replacement);
        expect(hello).toEqual({ type: 'node-worker-hello', version: 1, role: 'session', pid: confirmed.mainPid });
        expect(confirmed.unitName).toBe(identity.unitName);
        await replacementFrames.return(undefined);
      } finally { await owner.stop(replacement); }
      expect(await marker.read()).toBeNull();
    } finally {
      coordinator.kill();
      await coordinator.exited;
      await frames.return(undefined);
      if (identity) await runSystemdHelper({ kind: 'stop', identity }).catch(() => {});
      await marker?.release();
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});

async function waitForExit(pid: number): Promise<void> {
  const deadline = performance.now() + 5000;
  while (existsSync(`/proc/${pid}`)) {
    if (performance.now() >= deadline) throw new Error('Synthetic worker survived coordinator pipe EOF');
    await Bun.sleep(10);
  }
}
