import { NodeSessionMarkerFile } from '../../server/execution-node/systemd/session-marker.js';
import { NodeSessionHostOwner } from '../../server/execution-node/systemd/session-host.js';
import { runSystemdHelper } from '../../server/execution-node/systemd/helper-process.js';
import { encodeNodeWorkerFrame } from '../../server/execution-node/worker/framing.js';
import { createNodeWorkerWorkingDirectory, NODE_WORKER_BUN_OPTIONS, nodeWorkerCommand } from '../../server/execution-node/worker/launch.js';
import { NodeWorkerPeer, type NodeWorkerProcessPort } from '../../server/execution-node/worker/peer.js';
import { DEFAULT_NODE_REPLAY } from '../../server/execution-node/replay-cache.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const [runtimeDirectory, nodeId, phase] = process.argv.slice(2);
if (!runtimeDirectory || !nodeId || !['launch-only', 'identified', 'configured'].includes(phase!)) process.exit(2);
const marker = await NodeSessionMarkerFile.acquire({ runtimeDirectory, controllerId: 'synthetic-controller', nodeId,
  onCompromised() { process.exit(2); } });
const directory = await createNodeWorkerWorkingDirectory(runtimeDirectory);
const pipes: { child: NodeWorkerProcessPort | null } = { child: null };
const owner = new NodeSessionHostOwner({ nodeId, marker, helperWorkingDirectory: marker.helperWorkingDirectory,
  command: nodeWorkerCommand('session'),
  launchOptions: { workingDirectory: directory.path, environment: { BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS } },
  spawn(launch) {
    const child = Bun.spawn([...launch.argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
    pipes.child = child;
    return { exited: child.exited, closeInput() { void child.stdin.end(); }, kill() { child.kill(); } };
  }, exited() { process.exit(2); } });
await owner.reconcile();
const host = await owner.launch();
if (!pipes.child) throw new Error('Worker process was not captured');
const peer = new NodeWorkerPeer(pipes.child, { role: 'session', signal: AbortSignal.timeout(15_000), validate() {}, failed() { process.exit(2); } });
const workerPid = await peer.hello;
const inspected = phase === 'launch-only' ? await runSystemdHelper({ kind: 'inspect', launch: host.launch.identity }, { workingDirectory: marker.helperWorkingDirectory })
  : { kind: 'ready' as const, identity: await owner.confirm(host) };
if (inspected.kind !== 'ready') throw new Error('Synthetic worker has no containment identity');
if (workerPid !== inspected.identity.mainPid) throw new Error('Worker hello does not match containment identity');
if (phase === 'configured') {
  const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node-boot', logicalSessionId: 'synthetic-session' };
  owner.bind(host, session);
  await peer.configure(session, 1, { role: 'session', nodeId, storageDirectory: runtimeDirectory,
    instances: ['synthetic-first', 'synthetic-second'].map((id) => ({ id, agentId: 'direct-anthropic-compatible', label: id,
      homeDirectory: path.join(runtimeDirectory, id), environment: {}, workspaceIds: ['synthetic-workspace'], maxOperations: 1 })),
    workspaces: [{ id: 'synthetic-workspace', projectPath: runtimeDirectory }], replay: DEFAULT_NODE_REPLAY });
  await peer.admit(1);
}
const childPids = (await readFile(`/proc/${workerPid}/task/${workerPid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
await Bun.stdout.writer().write(encodeNodeWorkerFrame(JSON.stringify({ identity: inspected.identity, childPids, markerPath: marker.filePath }), 8192));
await host.process.exited;
process.exit(2);
