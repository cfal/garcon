import { NodeWorkerContainmentRelay } from './containment-relay.js';
import type { Subprocess } from 'bun';
import type { NodeWorkerRuntime, NodeWorkerRuntimeContext } from './bootstrap.js';
import { prepareNodeInstanceEnvironments } from './environment.js';
import { createNodeWorkerWorkingDirectory, NODE_WORKER_BUN_OPTIONS, nodeWorkerCommand } from './launch.js';
import { NodeWorkerPeer } from './peer.js';
import { NodeWorkerReady } from './ready.js';
import { NodeWorkerExecutionRouter } from './execution-router.js';
import type { NodeWorkerWriter } from './writer.js';
import { NodeWorkerTransportError } from './framing.js';
import { assertNodeOutputMemoryBudget } from './output-memory.js';
import { NodeWorkerSessionServices } from './session-services.js';
import { NodeWorkerServiceRouter } from './service-router.js';

interface HostedInstance {
  readonly instanceId: string;
  readonly process: Subprocess<'pipe', 'pipe', 'ignore'>;
  readonly peer: NodeWorkerPeer;
  readonly directory: { dispose(): Promise<void> };
}

export async function startNodeSessionRuntime(context: NodeWorkerRuntimeContext, writer: Pick<NodeWorkerWriter, 'submit' | 'waitForRelease'>): Promise<NodeWorkerRuntime> {
  return createNodeSessionRuntime(context, writer, () => nodeWorkerCommand('instance'));
}

export async function createNodeSessionRuntime(
  context: NodeWorkerRuntimeContext,
  writer: Pick<NodeWorkerWriter, 'submit' | 'waitForRelease'>,
  instanceCommand: () => readonly [string, ...string[]],
): Promise<NodeWorkerRuntime> {
  const { configuration, authority } = context;
  if (configuration.role !== 'session') throw new TypeError('Invalid session worker role');
  assertNodeOutputMemoryBudget(configuration.instances.length, configuration.replay, configuration.outputMemoryBytes);
  const children: HostedInstance[] = [];
  const containment = new NodeWorkerContainmentRelay(authority, writer);
  const ready = new NodeWorkerReady(authority.session);
  const validate = () => { authority.poll(); authority.signal.throwIfAborted(); };
  const instanceIds = new Set(configuration.instances.map((instance) => instance.id));
  const childFor = (instanceId: string) => {
    const child = children.find((child) => child.instanceId === instanceId);
    if (!child) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
    return child.peer;
  };
  let services: NodeWorkerSessionServices | null = null;
  let requests: NodeWorkerServiceRouter;
  let execution: NodeWorkerExecutionRouter;
  let closing: Promise<void> | null = null;
  const close = () => { execution?.close(); requests?.close(); services?.close(); return closing ??= closeInstances(children); };
  try {
    services = instanceIds.size ? new NodeWorkerSessionServices({ authority, writer, instanceIds,
      replay: configuration.replay, child: childFor }) : null;
    requests = new NodeWorkerServiceRouter(context.connectionId, { authority, writer,
      execute: async (...args) => services ? services.service(...args) : { kind: 'rejected', code: 'NODE_UNAVAILABLE' } });
    execution = new NodeWorkerExecutionRouter(context.connectionId, { authority, writer,
      instanceIds,
      execute(instanceId, connectionId, _connection, command, signal, deadline) {
        const child = children.find((child) => child.instanceId === instanceId);
        if (!child) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
        return child.peer.execution(instanceId, connectionId).call(command, signal, deadline);
      } });
    const environments = await prepareNodeInstanceEnvironments(configuration.instances, authority.signal);
    for (const instance of configuration.instances) {
      validate();
      const directory = await createNodeWorkerWorkingDirectory(configuration.storageDirectory);
      let child: HostedInstance['process'];
      let startupTimeoutMs: number;
      try {
        validate();
        startupTimeoutMs = context.startup.remainingMs;
        if (startupTimeoutMs === 0) throw new NodeWorkerTransportError('NODE_WORKER_TIMEOUT');
        child = Bun.spawn([...instanceCommand()], { cwd: directory.path,
          env: { ...environments.get(instance.id)!.values, BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS },
          stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
      } catch (error) { await directory.dispose(); throw error; }
      const peer = new NodeWorkerPeer(child, { role: 'instance', signal: authority.signal, validate,
        startupTimeoutMs,
        containmentRequested: (request) => containment.request(request),
        received: (frame, text) => services!.receiveChild(instance.id, frame, text),
        failed() { if (!containment.requested) authority.retire(); } });
      children.push({ instanceId: instance.id, process: child, peer, directory });
      await peer.hello;
      const manifests = await peer.configure(authority.session, context.connectionId, { role: 'instance',
        nodeId: configuration.nodeId, storageDirectory: configuration.storageDirectory, instance,
        workspaces: configuration.workspaces.filter((workspace) => instance.workspaceIds.includes(workspace.id)) });
      for (const manifest of manifests) ready.add(manifest);
    }
    validate();
    return { manifests: ready.manifests, close,
      application(frame) {
        validate();
        if (frame.type === 'node-worker-execution') { execution.receive(frame); return; }
        if (frame.type === 'node-worker-service-request' || frame.type === 'node-worker-service-cancel') { requests.receive(frame); return; }
        if (!services) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
        switch (frame.type) {
          case 'node-worker-bulk': services.bulk(frame); return;
          case 'node-worker-output-retired': services.retirement(frame, 'coordinator'); return;
          case 'node-worker-output-ack': services.acknowledge(frame); return;
          default: throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
        }
      },
      async control(message) {
        validate();
        if (message.type === 'node-worker-attach') { execution.attach(message.connectionId); requests.attach(message.connectionId); services?.disconnected(); }
        if (message.type === 'node-worker-disconnect') services?.disconnected();
        await Promise.all(children.map(({ peer }) => {
          switch (message.type) {
            case 'node-worker-attach': return peer.attach(message.connectionId);
            case 'node-worker-admit': return peer.admit(message.connectionId);
            case 'node-worker-disconnect': return peer.disconnect(message.connectionId);
          }
        }));
        validate();
      } };
  } catch (error) { await close(); throw error; }
}

async function closeInstances(children: readonly HostedInstance[]): Promise<void> {
  for (const child of children) child.peer.closeInput();
  const results = await Promise.allSettled(children.map(async (child) => {
    const timer = setTimeout(() => child.process.kill('SIGKILL'), 1_000);
    try { await child.process.exited; }
    finally { clearTimeout(timer); }
    await child.directory.dispose();
  }));
  if (results.some((result) => result.status === 'rejected')) throw new Error('Worker process cleanup is unavailable');
}
