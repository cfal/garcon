import { DEFAULT_NODE_EXECUTABLE_SEARCH_PATH } from '../../../server/execution-node/worker/configuration.js';
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_NODE_REPLAY } from '../../../server/execution-node/replay-cache.js';
import { createNodeWorkerWorkingDirectory, NODE_WORKER_BUN_OPTIONS, nodeWorkerCommand } from '../../../server/execution-node/worker/launch.js';
import { NodeWorkerPeer } from '../../../server/execution-node/worker/peer.js';
import { withTimeout } from '../../support/deferred.js';

test.skipIf(process.platform !== 'linux')('a foreign auth completion retires the real session and siblings with an unknown upstream outcome', async () => {
  const storage = await mkdtemp(path.join(homedir(), 'garcon-auth-reply-failure-'));
  const directory = await createNodeWorkerWorkingDirectory(storage);
  const command = nodeWorkerCommand('session');
  const preload = fileURLToPath(new URL('../../support/node-session-auth-reply-preload.ts', import.meta.url));
  const child = Bun.spawn([command[0], '--preload', preload, ...command.slice(1)], { cwd: directory.path,
    env: { PATH: '/usr/bin:/bin', BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', timeout: 10_000 });
  const failed = Promise.withResolvers<void>();
  const signal = AbortSignal.timeout(10_000);
  const peer = new NodeWorkerPeer(child, { role: 'session', signal, validate() {}, failed() { failed.resolve(); } });
  try {
    await peer.hello;
    const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
    const instances = ['synthetic-first', 'synthetic-second'].map((id) => ({ id, agentId: 'direct-anthropic-compatible', label: id,
      homeDirectory: path.join(storage, id), environment: {}, workspaceIds: ['synthetic-workspace'], maxOperations: 1 }));
    await peer.configure(session, 1, { role: 'session', nodeId: 'synthetic-node', storageDirectory: storage, executableSearchPath: DEFAULT_NODE_EXECUTABLE_SEARCH_PATH,
      instances, workspaces: [{ id: 'synthetic-workspace', projectPath: storage }], replay: DEFAULT_NODE_REPLAY });
    await peer.admit(1);
    const children = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/).map(Number);
    expect(children).toHaveLength(2);
    expect(await peer.service(1).call({ method: 'provider-auth', instanceId: 'synthetic-first', operation: 'complete-login',
      sessionId: 'synthetic-login', code: 'synthetic-code' }, signal)).toEqual({ kind: 'unknown' });
    expect(await withTimeout(child.exited, 3000, () => 'Session stayed alive after an invalid child auth reply')).not.toBe(0);
    await failed.promise;
    for (const pid of children) expect(existsSync(`/proc/${pid}`)).toBe(false);
  } finally {
    peer.closeInput(); await child.exited;
    await rm(storage, { recursive: true, force: true });
  }
}, 15_000);
