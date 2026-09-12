import { expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_NODE_REPLAY } from '../../../server/execution-node/replay-cache.js';
import { NodeWorkerPeer } from '../../../server/execution-node/worker/peer.js';
import { createNodeWorkerWorkingDirectory, NODE_WORKER_BUN_OPTIONS, nodeWorkerCommand } from '../../../server/execution-node/worker/launch.js';
import type { NodeExecutionCommand } from '../../../server/execution-nodes/transport/execution-wire.js';
import { NODE_WORKER_EXECUTION_LIMITS } from '../../../server/execution-node/worker/limits.js';

test('execution RPC reaches only its configured instance and preserves operation receipts across physical reconnect', async () => {
  const storage = await mkdtemp(path.join(homedir(), 'garcon-worker-rpc-'));
  const directory = await createNodeWorkerWorkingDirectory(storage);
  const child = Bun.spawn(nodeWorkerCommand('session'), { cwd: directory.path,
    env: { PATH: '/usr/bin:/bin', BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', timeout: 15_000 });
  const failed = mock(() => {});
  const signal = AbortSignal.timeout(15_000);
  const peer = new NodeWorkerPeer(child, { role: 'session', signal, validate() {}, failed });
  const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
  const nodeId = 'synthetic-node';
  try {
    await peer.hello;
    const instances = ['synthetic-first', 'synthetic-second'].map((id) => ({ id, agentId: 'direct-anthropic-compatible', label: id,
      homeDirectory: path.join(storage, id), environment: {}, workspaceIds: ['synthetic-workspace'], maxOperations: 1 }));
    const manifests = await peer.configure(session, 1, { role: 'session', nodeId, storageDirectory: storage, instances,
      workspaces: [{ id: 'synthetic-workspace', projectPath: storage }], replay: DEFAULT_NODE_REPLAY });
    expect(manifests.every((manifest) => Object.entries(manifest.facets).every(([facet, present]) => present === (facet === 'catalog' || facet === 'auth' ? true : null)))).toBe(true);
    const first = peer.execution('synthetic-first', 1);
    const second = peer.execution('synthetic-second', 1);
    const prepare = (instanceId: string): NodeExecutionCommand => ({ method: 'prepare',
      location: { nodeId, instanceId, workspaceId: 'synthetic-workspace' }, request: { kind: 'start', chatId: '1789000000000001',
        runId: 'synthetic-run', configuration: { model: 'synthetic-model', endpoint: null, settings: null } } });
    expect(await first.call(prepare('synthetic-first'), signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    await peer.admit(1);
    expect(await second.call(prepare('synthetic-first'), signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    const firstResult = await first.call(prepare('synthetic-first'), signal);
    const secondResult = await second.call(prepare('synthetic-second'), signal);
    if (firstResult.kind !== 'prepared' || secondResult.kind !== 'prepared') throw new Error('Synthetic RPC preparation failed');
    expect(firstResult.ticket.location.instanceId).toBe('synthetic-first');
    expect(secondResult.ticket.location.instanceId).toBe('synthetic-second');
    const burst = await Promise.all(Array.from({ length: NODE_WORKER_EXECUTION_LIMITS.maxRequests + NODE_WORKER_EXECUTION_LIMITS.reservedControlRequests },
      () => first.call({ method: 'status', identity: firstResult.ticket.identity }, signal)));
    expect(burst.every((result) => result.kind === 'status' && result.receipt?.phase === 'prepared')).toBe(true);
    expect(await first.call(prepare('synthetic-first'), signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(await second.call({ method: 'status', identity: firstResult.ticket.identity }, signal)).toEqual({ kind: 'status', receipt: null });
    await peer.disconnect(1);
    await peer.disconnect(1);
    await peer.attach(2);
    expect(await first.call({ method: 'status', identity: firstResult.ticket.identity }, signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    const recovered = peer.execution('synthetic-first', 2);
    expect(await recovered.call({ method: 'status', identity: firstResult.ticket.identity }, signal))
      .toMatchObject({ kind: 'status', receipt: { identity: firstResult.ticket.identity, phase: 'prepared' } });
    expect(await recovered.call(prepare('synthetic-first'), signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    await peer.admit(2);
    expect(await recovered.call({ method: 'release', identity: firstResult.ticket.identity }, signal)).toEqual({ kind: 'released' });
    expect(await recovered.call(prepare('synthetic-first'), signal)).toMatchObject({ kind: 'prepared' });
    expect(failed).not.toHaveBeenCalled();
  } finally {
    peer.closeInput();
    await child.exited;
    await rm(storage, { recursive: true, force: true });
  }
}, 20_000);
