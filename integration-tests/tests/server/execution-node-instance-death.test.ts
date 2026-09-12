import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_NODE_REPLAY } from '../../../server/execution-node/replay-cache.js';
import { createNodeWorkerWorkingDirectory, NODE_WORKER_BUN_OPTIONS, nodeWorkerCommand } from '../../../server/execution-node/worker/launch.js';
import { NodeWorkerPeer } from '../../../server/execution-node/worker/peer.js';

test.skipIf(process.platform !== 'linux')('instance death exits its session worker and reaps every sibling while the coordinator pipe stays open', async () => {
  const storage = await mkdtemp(path.join(homedir(), 'garcon-instance-death-'));
  const directory = await createNodeWorkerWorkingDirectory(storage);
  const child = Bun.spawn(nodeWorkerCommand('session'), { cwd: directory.path,
    env: { PATH: '/usr/bin:/bin', BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', timeout: 10_000 });
  const failed = Promise.withResolvers<void>();
  const peer = new NodeWorkerPeer(child, { role: 'session', signal: AbortSignal.timeout(10_000), validate() {}, failed() { failed.resolve(); } });
  let deadline: ReturnType<typeof setTimeout> | null = null;
  try {
    await peer.hello;
    const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
    const instances = ['synthetic-first', 'synthetic-second'].map((id) => ({ id, agentId: 'direct-anthropic-compatible', label: id,
      homeDirectory: path.join(storage, id), environment: {}, workspaceIds: ['synthetic-workspace'], maxOperations: 1 }));
    await peer.configure(session, 1, { role: 'session', nodeId: 'synthetic-node', storageDirectory: storage,
      instances, workspaces: [{ id: 'synthetic-workspace', projectPath: storage }], replay: DEFAULT_NODE_REPLAY });
    await peer.admit(1);
    const children = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/).map(Number);
    expect(children).toHaveLength(2);
    process.kill(children[0]!, 'SIGKILL');
    const expired = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('Session worker retained an open lifeline after instance death')), 3000);
    });
    expect(await Promise.race([child.exited, expired])).not.toBe(0);
    await failed.promise;
    for (const pid of children) expect(existsSync(`/proc/${pid}`)).toBe(false);
  } finally {
    if (deadline) clearTimeout(deadline);
    peer.closeInput(); await child.exited;
    await rm(storage, { recursive: true, force: true });
  }
}, 15_000);
