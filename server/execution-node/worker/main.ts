import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { NodeWorkerBootstrap } from './bootstrap.js';
import { readNodeWorkerFrames, NodeWorkerTransportError } from './framing.js';
import { NodeWorkerLifeline } from './lifeline.js';
import { reserveNodeWorkerStdout } from './pipes.js';
import { MAX_NODE_WORKER_LIFECYCLE_BYTES, serializeNodeWorkerChild } from './protocol.js';
import { nodeWorkerRoleFlag, type NodeWorkerRole } from './roles.js';
import { NodeWorkerWriter } from './writer.js';
import { NODE_WORKER_WRITER_LIMITS } from './limits.js';

export async function runNodeWorkerMain(role: NodeWorkerRole): Promise<never> {
  if (process.argv.length !== 3 || process.argv[2] !== nodeWorkerRoleFlag(role)) process.exit(2);
  const port = reserveNodeWorkerStdout();
  process.umask(0o077);
  let bootstrap: NodeWorkerBootstrap | null = null;
  let stopping: Promise<void> | null = null;
  const stop = (error: NodeWorkerTransportError) => {
    if (stopping) return;
    // The external owner still verifies the entire systemd unit even after this process exits.
    const code = error.code === 'NODE_WORKER_CLOSED' ? 0 : 1;
    stopping = Promise.resolve().then(async () => {
      const deadline = setTimeout(() => process.exit(code), 2_000);
      try { await bootstrap?.close(); }
      finally { clearTimeout(deadline); process.exit(code); }
    });
  };
  const lifeline = new NodeWorkerLifeline({ retired: stop });
  const writer = new NodeWorkerWriter(port, { ...NODE_WORKER_WRITER_LIMITS, signal: lifeline.signal, failed: stop });
  bootstrap = new NodeWorkerBootstrap({ role, lifeline, send: (text) => writer.send(text, 'control'), failed: stop,
    async start(context) {
      lifeline.poll();
      if (role === 'session') {
        const { startNodeSessionRuntime } = await import('./session-runtime.js');
        return startNodeSessionRuntime(context, writer);
      }
      const { startNodeInstanceRuntime } = await import('./instance-runtime.js');
      return startNodeInstanceRuntime(context, writer);
    } });
  try {
    await writer.send(serializeNodeWorkerChild({ type: 'node-worker-hello', version: NODE_WIRE_VERSION, role, pid: process.pid }), 'control');
    for await (const text of readNodeWorkerFrames(Bun.stdin.stream(), MAX_NODE_WORKER_LIFECYCLE_BYTES, lifeline.signal)) bootstrap.receive(text);
    stop(new NodeWorkerTransportError('NODE_WORKER_CLOSED'));
  } catch { stop(new NodeWorkerTransportError('NODE_WORKER_PROTOCOL')); }
  await stopping;
  process.exit(1);
}
