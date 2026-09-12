import { nodeWorkerReplies } from '../../execution-node/worker/reply-port.js';
import { expect, mock, test } from 'bun:test';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { NodeProviderCapacity } from '../../execution-node/provider-capacity.js';
import { NodeProviderConfigurationHost } from '../../execution-node/provider-configuration-host.js';
import { NodeWorkerServiceClient, NodeWorkerServiceServer } from '../../execution-node/worker/service-channel.js';
import { NODE_WORKER_SERVICE_LIMITS, NODE_WORKER_WRITER_LIMITS } from '../../execution-node/worker/limits.js';
import { parseNodeWorkerServiceText, type NodeWorkerServiceResult } from '../../execution-node/worker/service-protocol.js';
import { NodeWorkerWriter } from '../../execution-node/worker/writer.js';
import { DomainError } from '../../lib/domain-error.js';
import type { ProviderConfigurationUpdate, ProviderConfigurationUpdateRequest } from '../provider-configuration.js';
import { RemoteProviderConfigurationService } from '../remote-provider-configuration.js';
import { MAX_NODE_CONFIGURATION_UPDATE_REPLY_BYTES, MAX_NODE_CONFIGURATION_UPDATE_REQUEST_BYTES } from '../transport/provider-configuration-update-wire.js';

const snapshot = { model: 'synthetic-normalized', permissionMode: 'default' as const, thinkingMode: 'none' as const,
  settings: { ownerId: 'synthetic-provider', schemaVersion: 1, values: { normalized: true } }, endpoint: null };
const input: ProviderConfigurationUpdateRequest = { previous: { model: 'synthetic-original', settings: null, endpoint: null },
  next: { model: 'synthetic-requested', endpoint: null }, patch: { permissionMode: undefined } };
const signal = () => new AbortController().signal;

function fixture() {
  const physical = new AbortController();
  const failed = mock((error: unknown) => physical.abort(error));
  const options = { session: { controllerBootId: 'controller-boot', nodeBootId: 'node-boot', logicalSessionId: 'session' },
    connectionId: 1, signal: physical.signal, validate() {}, failed };
  const writerOptions = { ...NODE_WORKER_WRITER_LIMITS, signal: physical.signal,
    failed(error: unknown) { if (!physical.signal.aborted) failed(error); } };
  const prepareUpdate = mock(async (_request: ProviderConfigurationUpdateRequest, _signal: AbortSignal): Promise<ProviderConfigurationUpdate> =>
    structuredClone({ previous: snapshot, next: snapshot }));
  const capacity = new NodeProviderCapacity();
  const host = new NodeProviderConfigurationHost(capacity, 'synthetic-instance', { prepareUpdate });
  let alter: (result: NodeWorkerServiceResult) => NodeWorkerServiceResult = (result) => result;
  const requests = new NodeWorkerWriter({ async write(bytes) {
    const frame = parseNodeWorkerServiceText(Buffer.from(bytes.subarray(4)).toString());
    if (!frame) throw new Error('Invalid synthetic configuration request');
    server.receive(frame);
  }, close() {} }, writerOptions);
  const replies = new NodeWorkerWriter({ async write(bytes) {
    const frame = parseNodeWorkerServiceText(Buffer.from(bytes.subarray(4)).toString());
    if (!frame || frame.type !== 'node-worker-service-result') throw new Error('Invalid synthetic configuration reply');
    client.receive({ ...frame, result: alter(frame.result) });
  }, close() {} }, writerOptions);
  const client = new NodeWorkerServiceClient(requests, options);
  const server = new NodeWorkerServiceServer(nodeWorkerReplies(replies), (command, signal) => command.method === 'provider-configuration'
    ? host.prepareUpdate(command, signal) : Promise.resolve({ kind: 'output-recovery', generation: 1 }), options);
  const channel = { session: options.session, service: client };
  const service = new RemoteProviderConfigurationService({ captureSource: () => null, instanceId: 'synthetic-instance', session: options.session, channel: () => channel });
  return { host, client, service, channel, prepareUpdate, capacity, physical, failed,
    alterReply(fn: typeof alter) { alter = fn; },
    close() { physical.abort(); client.close(); server.close(); requests.close(); replies.close(); } };
}

test('configuration preparation snapshots requests and returns the exact node-normalized settings', async () => {
  const f = fixture();
  const request = structuredClone(input);
  try {
    const pending = f.service.prepareUpdate(request, signal());
    Object.assign(request.next, { model: 'synthetic-later-edit' });
    expect(await pending).toEqual({ previous: snapshot, next: snapshot });
    expect(f.prepareUpdate).toHaveBeenCalledWith({ ...input, patch: {} }, expect.any(AbortSignal));
    await expect(new RemoteProviderConfigurationService({ captureSource: () => null, instanceId: 'foreign', session: f.channel.session, channel: () => f.channel }).prepareUpdate(input, signal()))
      .rejects.toMatchObject({ code: 'NODE_INCOMPATIBLE', retryable: false });
    expect(f.prepareUpdate).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('invalid and credential-bearing input fails before the provider or channel is invoked', async () => {
  const f = fixture();
  try {
    const malformed = { ...input, previous: { ...input.previous, endpoint: { credential: 'synthetic-secret' } } };
    await expect(f.service.prepareUpdate(malformed as unknown as ProviderConfigurationUpdateRequest, signal())).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    expect(f.prepareUpdate).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('typed provider refusals retain their classification without forwarding native error text', async () => {
  const f = fixture();
  try {
    f.prepareUpdate.mockRejectedValueOnce(new DomainError('VALIDATION_FAILED', 'synthetic-private-detail', 422));
    await expect(f.service.prepareUpdate(input, signal())).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, retryable: false,
      message: 'The instance rejected the settings update.' });
    for (const code of ['INVALID_SETTINGS', 'INVALID_ENDPOINT'] as const) {
      f.prepareUpdate.mockRejectedValueOnce(new AgentIntegrationError(code, 'synthetic-private-detail', false));
      try { await f.service.prepareUpdate(input, signal()); throw new Error('Synthetic refusal missing'); }
      catch (error) {
        expect(error).toBeInstanceOf(AgentIntegrationError); expect(error).toHaveProperty('code', code);
        expect(String(error)).not.toContain('synthetic-private-detail');
      }
    }
    f.prepareUpdate.mockRejectedValueOnce(new Error('synthetic-private-native-failure'));
    await expect(f.service.prepareUpdate(input, signal())).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE', status: 503, retryable: true });
    expect(f.prepareUpdate).toHaveBeenCalledTimes(4); expect(f.physical.signal.aborted).toBe(false);
  } finally { f.close(); }
});

test('foreign replies and channel loss never yield an accepted settings snapshot', async () => {
  const f = fixture();
  try {
    f.alterReply((result) => result.kind === 'provider-configuration-prepared' ? { ...result, instanceId: 'foreign' } : result);
    await expect(f.service.prepareUpdate(input, signal())).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    expect(f.failed).toHaveBeenCalledTimes(1);
    await expect(f.service.prepareUpdate(input, signal())).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    expect(f.prepareUpdate).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('expanded defaults cross the channel and excessive defaults surface as a settings limit', async () => {
  const f = fixture();
  const expanded = { ...snapshot, settings: { ...snapshot.settings, values: { default: 'd'.repeat(MAX_NODE_CONFIGURATION_UPDATE_REQUEST_BYTES) } } };
  try {
    f.prepareUpdate.mockResolvedValueOnce({ previous: expanded, next: expanded });
    expect(await f.service.prepareUpdate(input, signal())).toEqual({ previous: expanded, next: expanded });
    const excessive = { ...expanded, settings: { ...expanded.settings, values: { default: 'd'.repeat(MAX_NODE_CONFIGURATION_UPDATE_REPLY_BYTES) } } };
    f.prepareUpdate.mockResolvedValueOnce({ previous: excessive, next: excessive });
    await expect(f.service.prepareUpdate(input, signal())).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, retryable: false,
      message: 'The normalized provider settings exceed the node transport limit.' });
    f.prepareUpdate.mockResolvedValueOnce({ previous: snapshot, next: { ...excessive, credential: 'synthetic-secret' } } as never);
    await expect(f.service.prepareUpdate(input, signal())).rejects.toMatchObject({ code: 'NODE_INCOMPATIBLE', status: 502, retryable: false });
    expect(f.prepareUpdate).toHaveBeenCalledTimes(3); expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('cancelled preparation retains shared native capacity until settlement while controls stay available', async () => {
  const f = fixture();
  const count = NODE_WORKER_SERVICE_LIMITS.maxProviderRequests - NODE_WORKER_SERVICE_LIMITS.reservedProviderStatusRequests;
  const entered = Promise.withResolvers<void>(); const native = Promise.withResolvers<ProviderConfigurationUpdate>();
  f.prepareUpdate.mockImplementation(() => { if (f.prepareUpdate.mock.calls.length === count) entered.resolve(); return native.promise; });
  const caller = new AbortController(); const reason = new Error('Synthetic settings cancellation');
  const pending = Array.from({ length: count }, () => f.service.prepareUpdate(input, caller.signal).catch((error: unknown) => error));
  try {
    await entered.promise; caller.abort(reason);
    expect(await Promise.all(pending)).toEqual(Array.from({ length: count }, () => reason));
    expect(f.capacity.reserve('work')).toBeNull();
    await expect(f.service.prepareUpdate(input, signal())).rejects.toMatchObject({ code: 'NODE_CAPACITY', retryable: true });
    expect(await f.client.call({ method: 'begin-output-recovery' }, signal())).toEqual({ kind: 'output-recovery', generation: 1 });
    native.resolve({ previous: snapshot, next: snapshot });
    await native.promise;
  } finally { native.resolve({ previous: snapshot, next: snapshot }); await Promise.all(pending); f.close(); }
});
