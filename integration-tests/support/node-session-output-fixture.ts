import { createHash } from 'node:crypto';
import { NODE_WIRE_VERSION, type AgentProducerEvent, type ProducerStreamIdentity } from '../../server-agents/interface/src/index.js';
import { sameNodeSession, type NodeOperationIdentity } from '../../common/node-operation.js';
import type { NodeHostedConnection } from '../../server/execution-node/session-coordinator.js';
import { NodeOutputAssemblyBudget } from '../../server/execution-node/worker/output-budget.js';
import type { NodeWorkerApplicationFrame } from '../../server/execution-node/worker/application-protocol.js';
import { NodeOutputRecovery } from '../../server/execution-nodes/output-recovery.js';
import { NodeExecutionReconciliation, type NodeTrackedExecution } from '../../server/execution-nodes/execution-reconciliation.js';
import { NodePublicationRoutes, type NodePublicationRoute } from '../../server/execution-nodes/publication-routes.js';
import { NodePermissionReconciliation } from '../../server/execution-nodes/permission-reconciliation.js';
import type { ProviderExecutionOutput } from '../../server/execution-nodes/provider-execution.js';
import type { ProviderConfigurationRequest } from '../../server/execution-nodes/provider-configuration.js';
import { NodeBulkChannel } from '../../server/execution-nodes/transport/bulk-channel.js';
import { serializeNodeBulkFrame } from '../../server/execution-nodes/transport/bulk-channel-wire.js';
import { MAX_NODE_BULK_CHUNK_BYTES } from '../../server/execution-nodes/transport/bulk-wire.js';
import { serializeNodeExecutionBody } from '../../server/execution-nodes/transport/execution-body-wire.js';
import type { NodeExecutionResult } from '../../server/execution-nodes/transport/execution-receipt-wire.js';
import { createNodeSessionFixture, type ControllerFixtureConnection, type NodeSessionFixtureOptions } from './node-session-handshake-fixture.js';
import { withTimeout } from './deferred.js';
import type { TestCertificate } from './tls-certificates.js';

interface OutputStream {
  readonly stream: ProducerStreamIdentity;
  readonly route: NodePublicationRoute;
  readonly events: AgentProducerEvent[];
  readonly failures: unknown[];
  readonly retired: boolean;
}

export async function createNodeSessionOutputFixture(certificate: TestCertificate, options: NodeSessionFixtureOptions = {}) {
  const host = await createNodeSessionFixture(certificate, certificate.trust, options);
  const first = host.connect();
  let connection: NodeHostedConnection;
  try { connection = await first.ready; }
  catch (error) { await host.dispose(); throw error; }
  const session = connection.lease.session;
  const lifetime = new AbortController();
  const instanceId = 'synthetic-instance';
  const operations = new Map<string, NodeTrackedExecution>();
  const failures: unknown[] = [];
  const observers = new Set<() => void>();
  const delivery = new Set<(frame: NodeWorkerApplicationFrame, text: string) => void>();
  const notify = () => { for (const observer of observers) observer(); };
  const failed = (error: unknown) => { failures.push(error); notify(); };
  let acknowledge = true;
  let ready = false;
  let recoveryCount = 0;
  let recovery: NodeOutputRecovery;
  let bulk: NodeBulkChannel;
  let controller: ControllerFixtureConnection;
  let physical = first;
  const signal = AbortSignal.any([lifetime.signal, connection.lease.authoritySignal]);
  const routes = new NodePublicationRoutes({ session, instanceIds: new Set([instanceId]), signal,
    budget: new NodeOutputAssemblyBudget(32 * 1024 * 1024), now: () => performance.now(), validate() { signal.throwIfAborted(); }, failed });
  const executions = new NodeExecutionReconciliation({ session, instanceIds: new Set([instanceId]), signal,
    validate() { signal.throwIfAborted(); } });
  const permissions = new NodePermissionReconciliation({ session, signal, validate() { signal.throwIfAborted(); },
    assertAdmission() { if (!ready) throw new Error('Synthetic permission awaits output recovery'); } });

  const flushRetirements = (captured: ControllerFixtureConnection, caller: AbortSignal) =>
    routes.flushRetirements((frame, active) => captured.client.sendRetirementAndWaitForSocketDrain(frame, active), caller);

  async function attach(connected: NodeHostedConnection) {
    if (!sameNodeSession(connected.lease.session, session)) throw new Error('Synthetic reconnect changed logical authority');
    connection = connected;
    controller = await withTimeout(host.controller(connection), 5000, () => 'Synthetic controller did not finish handshake');
    const captured = controller;
    const signal = captured.signal;
    const connectionId = connection.connectionId;
    executions.attach({ session, connectionId, signal, validate: captured.validate,
      execution: (instance) => captured.client.execution(instance) });
    permissions.attach({ session, connectionId, signal, validate: captured.validate, service: captured.client.service });
    const transport = await withTimeout(captured.bulk, 5000, () => 'Synthetic bulk socket did not connect');
    const envelope = (payload: string) => ({ type: 'node-worker-bulk', version: NODE_WIRE_VERSION,
      session, connectionId, instanceId, payload } as const);
    bulk = new NodeBulkChannel({ send(payload) { return transport.send(envelope(payload)); },
      async sendWhenWritable(payload, caller, validate) { validate?.(); await transport.sendWhenWritable(envelope(payload), caller); },
      async writable(caller) { caller.throwIfAborted(); }, close() {} },
    { append() { throw new Error('Unexpected fixture body'); }, complete() { throw new Error('Unexpected fixture body'); }, cancel() {} },
    { session, signal, validate: captured.validate });
    const incomingBulk = bulk;
    captured.bulkReceived.add((frame) => incomingBulk.receive(frame.payload));
    const recovering = new NodeOutputRecovery({ session, connectionId, signal, service: captured.client.service, receiver: routes,
      cursors: () => routes.cursors(),
      validate: captured.validate, recovering() { ready = false; }, recovered() { ready = true; recoveryCount++; }, failed,
      retireGap: (range) => routes.retireGap(range),
      async reconcile(caller) {
        await executions.reconcile(connectionId, caller);
        await permissions.reconcile(connectionId, caller);
        await flushRetirements(captured, caller);
      },
    });
    recovery = recovering;
    captured.received.add((frame, text) => {
      if (frame.type === 'node-worker-output-delivery') {
        const { ack } = routes.receive(text);
        const attempt = recovering.attempt;
        if (acknowledge && ack && attempt) {
          try {
            if (!captured.client.admitOutputAck({ type: 'node-worker-output-ack', version: NODE_WIRE_VERSION,
              ...attempt, ack }, signal)) captured.client.close();
          } catch { captured.client.close(); }
        }
        notify();
      }
      else if (frame.type === 'node-worker-output-retired') routes.receiveRetirement(text);
      else if (frame.type === 'node-worker-output-suspended') recovering.receiveSuspension(text);
      else throw new Error('Unexpected fixture application frame');
      for (const listener of delivery) listener(frame, text);
    });
    signal.addEventListener('abort', () => { if (controller === captured) ready = false; }, { once: true });
  }
  try { await attach(connection); }
  catch (error) { routes.close(); lifetime.abort(); await host.dispose(); throw error; }

  return {
    host, session, signal, failures, delivery,
    get receipts(): ReadonlyMap<string, NodeExecutionResult> {
      return new Map([...operations].map(([id, operation]) => [id, { kind: 'status', receipt: operation.receipt }]));
    },
    interrupt(identity: NodeOperationIdentity) {
      const operation = operations.get(identity.operationId);
      if (!operation || !sameNodeSession(operation.identity, identity)) throw new Error('Synthetic foreign interrupt');
      return operation.interrupt();
    },
    get ready() { return ready; }, get connection() { return connection; }, get controller() { return controller; }, get bulk() { return bulk; },
    get recoveryCount() { return recoveryCount; },
    setAcknowledgements(enabled: boolean) { acknowledge = enabled; },
    recover: () => recovery.recover(),
    async disconnect() { controller.client.close(); physical.stop(); await physical.closed; },
    async reconnect() { physical = host.connect(); await attach(await physical.ready); },
    async install(streamId: string, output: ProviderExecutionOutput, isRunLive?: (runId: string) => boolean) {
      const stream = { ...session, streamId };
      const events: AgentProducerEvent[] = [];
      const errors: unknown[] = [];
      const route = routes.install({ instanceId, stream, output: { signal: output.signal,
        emit(event) {
          output.emit(event); events.push(event);
          if (event.type === 'run-ended') permissions.retireRun(stream, event.runId);
          else if (event.type === 'permission' && event.lifecycle.kind !== 'requested') {
            permissions.retireOccurrence(stream, event.runId, event.lifecycle.permissionOccurrenceId);
          }
        } },
        permission(handle, runId, permissionOccurrenceId) {
          if (!isRunLive) throw new Error('Unexpected fixture permission');
          return permissions.capture({ stream, handle, runId, permissionOccurrenceId }, route.signal, () => isRunLive(runId));
        },
        failed(error) { errors.push(error); notify(); } });
      route.signal.addEventListener('abort', () => {
        notify();
        if (ready && !signal.aborted) {
          const captured = controller;
          void flushRetirements(captured, captured.signal).catch(() => captured.client.close());
        }
      }, { once: true });
      const owner: OutputStream = { stream, route, events, failures: errors, get retired() { return route.signal.aborted; } };
      const result = await controller.client.service.call({ method: 'install-output', instanceId, stream }, controller.signal);
      if (result.kind !== 'output-installed') throw new Error(`Synthetic install failed: ${JSON.stringify(result)}`);
      return owner;
    },
    async start(owner: OutputStream, chatId: string, runId: string, configuration: ProviderConfigurationRequest, prompt: string,
      resumeSession?: Extract<AgentProducerEvent, { type: 'session' }>['session']) {
      if (!ready) throw new Error('Synthetic execution awaits output recovery');
      const client = controller.client.execution(instanceId);
      const signal = controller.signal;
      const prepared = await client.call({ method: 'prepare', location: { nodeId: host.pairing.nodeId, instanceId, workspaceId: 'synthetic-workspace' },
        request: resumeSession ? { kind: 'resume', chatId, runId, configuration,
          agentSessionId: resumeSession.agentSessionId, nativeSession: resumeSession.nativeSession }
          : { kind: 'start', chatId, runId, configuration } }, signal);
      if (prepared.kind !== 'prepared') throw new Error(`Synthetic preparation failed: ${JSON.stringify(prepared)}`);
      operations.set(prepared.ticket.identity.operationId, executions.track(instanceId, prepared.ticket.identity, prepared.ticket.runId));
      const bytes = serializeNodeExecutionBody({ kind: 'execution', input: { prompt, attachments: [], carriedContext: null } });
      const reserved = await controller.client.service.call({ method: 'reserve-body', instanceId, identity: prepared.ticket.identity,
        kind: 'execution', controlId: null, descriptor: { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }, signal);
      if (reserved.kind !== 'body-reserved') throw new Error(`Synthetic reservation failed: ${JSON.stringify(reserved)}`);
      for (let offset = 0; offset < bytes.length; offset += MAX_NODE_BULK_CHUNK_BYTES) await bulk.sendChunk(serializeNodeBulkFrame({
        type: 'node-bulk-chunk', version: NODE_WIRE_VERSION, transfer: reserved.transfer, offset,
        data: Buffer.from(bytes.subarray(offset, offset + MAX_NODE_BULK_CHUNK_BYTES)).toString('base64') }), signal);
      await bulk.complete(reserved.transfer, signal);
      const result = await client.call({ method: 'dispatch', identity: prepared.ticket.identity, stream: owner.stream, body: reserved.transfer }, signal);
      return { identity: prepared.ticket.identity, result };
    },
    async waitFor(owner: OutputStream, predicate: (event: AgentProducerEvent) => boolean) {
      const result = Promise.withResolvers<AgentProducerEvent>();
      const observe = () => {
        const event = owner.events.find(predicate);
        if (event) result.resolve(event);
        else if (owner.retired || failures.length) result.reject(new Error(`Synthetic output failed: ${String(owner.failures[0] ?? failures[0])}`));
      };
      observers.add(observe); observe();
      try { return await withTimeout(result.promise, 10_000, () => `Synthetic output missing; events=${owner.events.map((event) => event.type)}`); }
      finally { observers.delete(observe); }
    },
    async dispose() { recovery.close(); bulk.close(); lifetime.abort(); routes.close(); await host.dispose(); },
  };
}
