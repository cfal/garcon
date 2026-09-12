import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { NODE_WIRE_VERSION, parseNodeOutputText, type NodeOutputFrame, type NodeReplayReply, type ProducerStreamIdentity } from '../../server-agents/interface/src/index.js';
import { NodeOutputRecovery } from '../../server/execution-nodes/output-recovery.js';
import { DomainError } from '../../server/lib/domain-error.js';
import type { ProviderConfigurationRequest } from '../../server/execution-nodes/provider-configuration.js';
import type { NodeOperationIdentity } from '../../common/node-operation.js';
import { DEFAULT_NODE_REPLAY, type NodeReplayOptions } from '../../server/execution-node/replay-cache.js';
import { NodeWorkerPeer } from '../../server/execution-node/worker/peer.js';
import { createNodeWorkerWorkingDirectory, NODE_WORKER_BUN_OPTIONS, nodeWorkerCommand } from '../../server/execution-node/worker/launch.js';
import { NodeOutputAssemblyBudget } from '../../server/execution-node/worker/output-budget.js';
import { NodeWorkerOutputDeliveryReceiver } from '../../server/execution-node/worker/output-delivery-receiver.js';
import type { NodeWorkerServiceCommand } from '../../server/execution-node/worker/service-protocol.js';
import { NodeBulkChannel } from '../../server/execution-nodes/transport/bulk-channel.js';
import { serializeNodeBulkFrame } from '../../server/execution-nodes/transport/bulk-channel-wire.js';
import { serializeNodeExecutionBody } from '../../server/execution-nodes/transport/execution-body-wire.js';
import { MAX_NODE_BULK_CHUNK_BYTES } from '../../server/execution-nodes/transport/bulk-wire.js';
import { withTimeout } from './deferred.js';

interface FixtureInstance {
  readonly id: string;
  readonly agentId: string;
  readonly environment: Readonly<Record<string, string>>;
}

interface FixtureStream {
  readonly instanceId: string;
  readonly stream: ProducerStreamIdentity;
  readonly frames: NodeOutputFrame[];
  readonly failures: unknown[];
  retired: boolean;
  accepted: number;
}

export async function startWorkerSessionFixture(instances: readonly FixtureInstance[], replay: NodeReplayOptions = DEFAULT_NODE_REPLAY) {
  const storage = await mkdtemp(path.join(homedir(), 'garcon-worker-session-'));
  const directory = await createNodeWorkerWorkingDirectory(storage);
  const lifetime = new AbortController();
  const failures: unknown[] = [];
  const streams = new Map<string, FixtureStream>();
  const observers = new Set<() => void>();
  const channels = new Map<string, NodeBulkChannel>();
  const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
  let physical = new AbortController(); let connectionId = 1;
  let recovery: NodeOutputRecovery | null = null;
  let outputReady = false;
  let recoveryCount = 0;
  const gaps: NodeReplayReply[] = [];
  const retirements = new Set<Promise<void>>();
  let acknowledge = true;
  const failed = (error: unknown) => { failures.push(error); for (const observer of observers) observer(); };
  const child = Bun.spawn(nodeWorkerCommand('session'), { cwd: directory.path,
    env: { PATH: '/usr/bin:/bin', BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', timeout: 90_000 });
  const receiver = new NodeWorkerOutputDeliveryReceiver({ session, instanceIds: new Set(instances.map(({ id }) => id)),
    signal: lifetime.signal, budget: new NodeOutputAssemblyBudget(32 * 1024 * 1024), now: () => performance.now(), validate() {}, failed });
  const peer = new NodeWorkerPeer(child, { role: 'session', signal: lifetime.signal, validate() {}, failed,
    received(frame, text) {
      if (frame.type === 'node-worker-bulk') { channels.get(frame.instanceId)!.receive(frame.payload); return; }
      if (frame.type === 'node-worker-output-retired') { receiver.receiveRetirement(text); return; }
      if (frame.type === 'node-worker-output-delivery') { receiver.receive(text); return; }
      if (frame.type === 'node-worker-output-suspended' && recovery) { recovery.receiveSuspension(text); return; }
      throw new Error('Unexpected fixture application frame');
    } });
  const call = (command: NodeWorkerServiceCommand) => peer.service(connectionId).call(command, physical.signal);
  const close = async () => {
    recovery?.close(); physical.abort(); lifetime.abort(); receiver.close(); peer.closeInput();
    for (const channel of channels.values()) channel.close();
    await child.exited; await rm(storage, { recursive: true, force: true });
  };
  try {
    await peer.hello;
    await peer.configure(session, connectionId, { role: 'session', nodeId: session.nodeBootId, storageDirectory: storage,
      instances: instances.map((instance) => ({ ...instance, label: instance.id, homeDirectory: path.join(storage, instance.id),
        workspaceIds: ['synthetic-workspace'], maxOperations: 2 })),
      workspaces: [{ id: 'synthetic-workspace', projectPath: storage }], replay });
    await peer.admit(connectionId);
  } catch (error) { await close(); throw error; }
  const bulkFor = (instanceId: string) => {
    let channel = channels.get(instanceId);
    if (channel) return channel;
    const signal = physical.signal; const capturedId = connectionId;
    const forward = (payload: string, caller = signal) => peer.forward({ type: 'node-worker-bulk', version: NODE_WIRE_VERSION,
      session, connectionId: capturedId, instanceId, payload }, caller);
    channel = new NodeBulkChannel({ send(payload) { forward(payload); return true; },
      async sendWhenWritable(payload, caller, validate) { validate?.(); await forward(payload, caller).drained; },
      async writable(caller) { caller.throwIfAborted(); }, close() {} },
    { append() { throw new Error('Unexpected fixture body'); }, complete() { throw new Error('Unexpected fixture body'); }, cancel() {} },
    { session, signal, validate() { signal.throwIfAborted(); } });
    channels.set(instanceId, channel); return channel;
  };
  const install = async (instanceId: string, streamId: string) => {
    const stream = { ...session, streamId };
    const owner: FixtureStream = { stream, instanceId, frames: [], failures: [], retired: false, accepted: 0 };
    streams.set(streamId, owner);
    receiver.install(instanceId, stream, lifetime.signal, (text) => {
      const frame = parseNodeOutputText(text)!;
      if (frame.sequence > owner.accepted) {
        if (frame.sequence !== owner.accepted + 1) throw new Error('Noncontiguous fixture output');
        owner.frames.push(frame); owner.accepted = frame.sequence;
      }
      const attempt = recovery?.attempt;
      if (acknowledge && attempt) void peer.forward({ type: 'node-worker-output-ack', version: NODE_WIRE_VERSION,
        ...attempt, ack: { type: 'node-output-ack', stream, throughSequence: owner.accepted } }, physical.signal).drained.catch(failed);
      for (const observer of observers) observer();
    }, (error) => { owner.retired = true; owner.failures.push(error); for (const observer of observers) observer(); });
    const result = await call({ method: 'install-output', instanceId, stream });
    if (result.kind !== 'output-installed') throw new Error(`Fixture installation failed: ${result.kind}`);
    return owner;
  };
  const sendRetirement = (instanceId: string, stream: ProducerStreamIdentity) => peer.forward({
    type: 'node-worker-output-retired', version: NODE_WIRE_VERSION, stream, instanceId }, lifetime.signal).drained;
  const makeRecovery = () => new NodeOutputRecovery({ session, connectionId, signal: physical.signal,
    service: peer.service(connectionId), receiver,
    cursors: () => [...streams.values()].filter(({ retired }) => !retired).map(({ stream, accepted }) => ({ stream, afterSequence: accepted })),
    validate() { lifetime.signal.throwIfAborted(); },
    recovering() { outputReady = false; }, recovered() { outputReady = true; recoveryCount++; }, failed,
    retireGap(range) {
      gaps.push(range);
      const owner = streams.get(range.stream.streamId);
      if (!owner || owner.retired) return;
      owner.retired = true;
      owner.failures.push(new DomainError('NODE_REPLAY_GAP', 'Synthetic output replay gap', 409));
      receiver.retire(owner.stream);
      const retired = sendRetirement(owner.instanceId, owner.stream);
      retirements.add(retired);
      void retired.then(() => retirements.delete(retired), (error) => { retirements.delete(retired); failed(error); });
    },
    async reconcile(signal) { await Promise.all(retirements); signal.throwIfAborted(); },
  });
  recovery = makeRecovery();
  const recover = async () => {
    gaps.length = 0;
    await recovery!.recover();
    await peer.admit(connectionId);
    return [...gaps];
  };
  return { storage, session, failures, install, recover, call, close, sendRetirement,
    get outputReady() { return outputReady; }, get recoveryCount() { return recoveryCount; },
    setAcknowledgements(enabled: boolean) { acknowledge = enabled; },
    async reconnect() {
      await peer.disconnect(connectionId); physical.abort();
      for (const channel of channels.values()) channel.close(); channels.clear();
      connectionId++; physical = new AbortController(); await peer.attach(connectionId);
      outputReady = false; recovery = makeRecovery();
    },
    async retire(owner: FixtureStream) {
      owner.retired = true; receiver.retire(owner.stream);
      await sendRetirement(owner.instanceId, owner.stream);
    },
    receipt(instanceId: string, identity: NodeOperationIdentity) {
      return peer.execution(instanceId, connectionId).call({ method: 'status', identity }, physical.signal);
    },
    async start(owner: FixtureStream, chatId: string, runId: string, configuration: ProviderConfigurationRequest, prompt = 'synthetic input') {
      if (!outputReady) throw new Error('Synthetic execution admission is waiting for output recovery');
      const client = peer.execution(owner.instanceId, connectionId);
      const prepared = await client.call({ method: 'prepare', location: { nodeId: session.nodeBootId,
        instanceId: owner.instanceId, workspaceId: 'synthetic-workspace' }, request: { kind: 'start', chatId, runId, configuration } }, physical.signal);
      if (prepared.kind !== 'prepared') throw new Error(`Fixture preparation failed: ${JSON.stringify(prepared)}`);
      const bytes = serializeNodeExecutionBody({ kind: 'execution', input: { prompt, attachments: [], carriedContext: null } });
      const reserved = await call({ method: 'reserve-body', instanceId: owner.instanceId, identity: prepared.ticket.identity,
        kind: 'execution', controlId: null, descriptor: { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });
      if (reserved.kind !== 'body-reserved') throw new Error(`Fixture body reservation failed: ${reserved.kind}`);
      const bulk = bulkFor(owner.instanceId);
      for (let offset = 0; offset < bytes.length; offset += MAX_NODE_BULK_CHUNK_BYTES) await bulk.sendChunk(serializeNodeBulkFrame({
        type: 'node-bulk-chunk', version: NODE_WIRE_VERSION, transfer: reserved.transfer, offset,
        data: Buffer.from(bytes.subarray(offset, offset + MAX_NODE_BULK_CHUNK_BYTES)).toString('base64') }), physical.signal);
      await bulk.complete(reserved.transfer, physical.signal);
      const result = await client.call({ method: 'dispatch', identity: prepared.ticket.identity, stream: owner.stream, body: reserved.transfer }, physical.signal);
      if (result.kind !== 'dispatched') throw new Error(`Fixture dispatch failed: ${JSON.stringify(result)}`);
      return prepared.ticket;
    },
    async waitFor(owner: FixtureStream, predicate: (frame: NodeOutputFrame) => boolean) {
      const received = Promise.withResolvers<NodeOutputFrame>();
      const observe = () => {
        const frame = owner.frames.find(predicate);
        if (frame) received.resolve(frame);
        else if (owner.failures.length || failures.length) received.reject(new Error('Fixture output failed'));
      };
      observers.add(observe); observe();
      try { return await withTimeout(received.promise, 25_000, () => `Missing fixture output; events=${owner.frames.map(({ event }) => event.type).join(',')}`); }
      finally { observers.delete(observe); }
    },
  };
}
