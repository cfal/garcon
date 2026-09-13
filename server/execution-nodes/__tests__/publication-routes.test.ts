import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  encodeWireProducerEvent, serializeNodeOutputFrame, type AgentProducerEvent,
} from '@garcon/server-agent-interface';
import { AssistantMessage, BashToolUseMessage } from '../../../common/chat-types.js';
import { TranscriptLedgerService } from '../../ledger/service.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { NodeOutputAssemblyBudget } from '../../execution-node/worker/output-budget.js';
import { NodeOutputRetirements } from '../../execution-node/output-retirements.js';
import { chunkNodeWorkerOutput } from '../../execution-node/worker/output-protocol.js';
import { serializeNodeWorkerOutputDelivery } from '../../execution-node/worker/output-delivery-protocol.js';
import { serializeNodeWorkerOutputRetirement, type NodeWorkerOutputRetirement } from '../../execution-node/worker/output-retirement.js';
import type { NodeOutputReceiverAttempt } from '../../execution-node/worker/output-delivery-receiver.js';
import type { ProviderExecutionOutput } from '../provider-execution.js';
import { NodePublicationRoutes, type NodePublicationRoute, type NodePublicationRouteOptions } from '../publication-routes.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const instanceId = 'synthetic-instance';
const at = '2026-09-11T00:00:00.000Z';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const directory = await mkdtemp(join(homedir(), 'garcon-publication-routes-'));
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(directory));
  const lifetime = new AbortController();
  const budget = new NodeOutputAssemblyBudget(32 * 1024 * 1024);
  const failed = mock((_error: unknown) => {});
  const validate = mock(() => {});
  const routes = new NodePublicationRoutes({ session, instanceIds: new Set([instanceId]),
    signal: lifetime.signal, budget, now: () => 0, validate, failed });
  let count = 0;
  const install = (chatId = `synthetic-chat-${++count}`, override?: Partial<NodePublicationRouteOptions>) => {
    if (!ledger.currentView(chatId)) ledger.initializeChat(chatId);
    const lease = ledger.openProducer(chatId, 'synthetic');
    const failure = mock((_error: unknown) => {});
    const output = Object.freeze<ProviderExecutionOutput>({ signal: lease.signal, emit: (event) => lease.sink.publish(event) });
    const options = { instanceId, stream: { ...session, streamId: `synthetic-stream-${++count}` }, output,
      permission() { throw new Error('Unexpected synthetic permission'); }, failed: failure, ...override } satisfies NodePublicationRouteOptions;
    return { lease, failure, chatId, options, route: routes.install(options) };
  };
  const begin = (connectionId = 1, generation = 1) => routes.begin(connectionId, generation, routes.cursors(), lifetime.signal);
  cleanup.push(async () => { lifetime.abort(); routes.close(); ledger.close(); await rm(directory, { recursive: true, force: true }); });
  return { ledger, lifetime, budget, failed, validate, routes, install, begin };
}

const row = (content = 'synthetic content'): AgentProducerEvent => ({ type: 'rows', rows: [{ message: new AssistantMessage(at, content) }] });

function frames(route: NodePublicationRoute, sequence: number, event: AgentProducerEvent, attempt: NodeOutputReceiverAttempt): readonly string[] {
  const serialized = serializeNodeOutputFrame({ type: 'node-output', stream: route.stream, sequence,
    event: encodeWireProducerEvent(event, { createHandle: () => 'synthetic-permission-handle', register() {} }) });
  return chunkNodeWorkerOutput(instanceId, serialized).map((payload) => serializeNodeWorkerOutputDelivery({
    type: 'node-worker-output-delivery', version: 1, session, ...attempt, payload,
  }));
}

test('ACK loss and replay preserve the captured V5 cursor without republishing committed rows', async () => {
  const f = await fixture(); const first = f.install(); const attempt = f.begin();
  const text = frames(first.route, 1, row(), attempt)[0]!;
  expect(f.routes.receive(text)).toMatchObject({ kind: 'record', ack: { throughSequence: 1 } });
  const committed = f.ledger.currentRows(first.chatId);
  expect(committed).toHaveLength(1);
  expect(first.route.acceptedSequence).toBe(1);
  expect(first.route.signal.aborted).toBe(false);
  f.routes.suspend(attempt);
  const replay = f.routes.begin(2, 2, [{ stream: first.route.stream, afterSequence: 0 }], f.lifetime.signal);
  expect(f.routes.receive(frames(first.route, 1, row(), replay)[0]!)).toMatchObject({ ack: { throughSequence: 1 } });
  expect(f.ledger.currentRows(first.chatId)).toEqual(committed);
  expect(f.routes.receive(text)).toEqual({ kind: 'retired', ack: null });
  expect(first.failure).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
});

test('an already accepted record is acknowledged before duplicate body decoding without disrupting the live suffix', async () => {
  const f = await fixture(); const first = f.install(); const attempt = f.begin();
  const text = frames(first.route, 1, row(), attempt)[0]!;
  expect(f.routes.receive(text).ack?.throughSequence).toBe(1);
  const committed = f.ledger.currentRows(first.chatId);
  const envelope = JSON.parse(text);
  const payload = JSON.parse(envelope.payload);
  payload.chunk.data = Buffer.alloc(Buffer.from(payload.chunk.data, 'base64').length, 120).toString('base64');
  envelope.payload = JSON.stringify(payload);
  expect(f.routes.receive(JSON.stringify(envelope))).toMatchObject({ kind: 'record', ack: { throughSequence: 1 } });
  expect(f.ledger.currentRows(first.chatId)).toEqual(committed);
  expect(f.routes.receive(frames(first.route, 2, row('synthetic suffix'), attempt)[0]!).ack?.throughSequence).toBe(2);
  expect(f.ledger.currentRows(first.chatId)).toHaveLength(2);
  expect(first.failure).not.toHaveBeenCalled();
  expect(f.failed).not.toHaveBeenCalled();
});

test('run completion retains rows and session publication until the producer source closes', async () => {
  const f = await fixture(); const first = f.install(); const attempt = f.begin();
  f.ledger.beginRun(first.chatId, 'synthetic-run');
  const events: AgentProducerEvent[] = [
    { type: 'run-ended', runId: 'synthetic-run', outcome: 'finished' },
    row('synthetic late row'),
    { type: 'session', session: { agentSessionId: 'synthetic-native', nativeSession: null, nativeSeedReceipt: null } },
    { type: 'notice', runId: 'synthetic-run', content: 'synthetic stale advisory' },
  ];
  for (const [index, event] of events.entries()) {
    expect(f.routes.receive(frames(first.route, index + 1, event, attempt)[0]!).ack?.throughSequence).toBe(index + 1);
  }
  expect(f.ledger.currentRows(first.chatId)).toHaveLength(3);
  expect(first.route.signal.aborted).toBe(false);
  first.lease.close();
  expect(first.route.signal.aborted).toBe(true);
  expect(f.routes.cursors()).toEqual([]);
  const sent: NodeWorkerOutputRetirement[] = [];
  await f.routes.flushRetirements(async (frame) => { sent.push(frame); }, f.lifetime.signal);
  await f.routes.flushRetirements(async (frame) => { sent.push(frame); }, f.lifetime.signal);
  expect(sent).toEqual([0, 1].map(() => ({ type: 'node-worker-output-retired', reason: 'output-retired', version: 1, instanceId, stream: first.route.stream })));
  expect(first.failure).not.toHaveBeenCalled();
});

test('source closure frees partial assembly and cannot redirect old chunks into a replacement on the same view', async () => {
  const f = await fixture(); const first = f.install(); const attempt = f.begin();
  const chunks = frames(first.route, 1, row('synthetic large '.repeat(20_000)), attempt);
  expect(chunks.length).toBeGreaterThan(1);
  expect(f.routes.receive(chunks[0]!).kind).toBe('chunk'); expect(f.budget.reservedBytes).toBeGreaterThan(0);
  first.lease.close();
  expect(f.budget.reservedBytes).toBe(0);
  const next = f.install(first.chatId);
  for (const chunk of chunks.slice(1)) expect(f.routes.receive(chunk)).toEqual({ kind: 'retired', ack: null });
  expect(f.ledger.currentRows(first.chatId)).toEqual([]);
  expect(f.routes.receive(frames(next.route, 1, row('synthetic replacement'), attempt)[0]!).ack?.throughSequence).toBe(1);
  expect(f.ledger.currentRows(first.chatId)).toMatchObject([{ message: { content: 'synthetic replacement' } }]);
  expect(first.failure).not.toHaveBeenCalled(); expect(next.failure).not.toHaveBeenCalled();
});

test('failed publication retires once without ACK and cannot fail an independent source', async () => {
  const f = await fixture();
  const error = new Error('synthetic uncertain commit');
  const first = f.install(undefined, { output: { signal: new AbortController().signal, emit() { throw error; } } });
  const sibling = f.install(); const attempt = f.begin();
  const text = frames(first.route, 1, row(), attempt)[0]!;
  expect(f.routes.receive(text)).toEqual({ kind: 'retired', ack: null });
  expect(f.routes.receive(text)).toEqual({ kind: 'retired', ack: null });
  expect(first.route.acceptedSequence).toBe(0);
  expect(first.failure).toHaveBeenCalledTimes(1); expect(first.failure).toHaveBeenCalledWith(error);
  expect(f.routes.receive(frames(sibling.route, 1, row(), attempt)[0]!).ack?.throughSequence).toBe(1);
  expect(sibling.failure).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
});

test('a replay gap retires only the exact stream and old retirement cannot touch its successor', async () => {
  const f = await fixture(); const first = f.install(); const sibling = f.install();
  f.routes.retireGap({ type: 'node-replay-gap', stream: first.route.stream, requestedAfter: 0, firstRetainedSequence: 2, lastProducedSequence: 2 });
  expect(first.failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'NODE_REPLAY_GAP' }));
  const next = f.routes.install({ ...first.options, stream: { ...session, streamId: 'synthetic-successor' } });
  f.routes.receiveRetirement(serializeNodeWorkerOutputRetirement({ type: 'node-worker-output-retired', reason: 'output-retired', version: 1, instanceId, stream: first.route.stream }));
  expect(next.signal.aborted).toBe(false); expect(sibling.route.signal.aborted).toBe(false);
  expect(first.failure).toHaveBeenCalledTimes(1);
  expect(f.routes.cursors().map(({ stream }) => stream)).toEqual([sibling.route.stream, next.stream]);
});

test('duplicate installation cannot retire or replace the original publisher', async () => {
  const f = await fixture(); const first = f.install(); const attempt = f.begin();
  expect(() => f.routes.install(first.options)).toThrow('cannot be rebound');
  expect(first.route.signal.aborted).toBe(false);
  expect(f.routes.receive(frames(first.route, 1, row(), attempt)[0]!).ack?.throughSequence).toBe(1);
  first.route.retire();
  expect(() => f.routes.install(first.options)).toThrow('cannot be rebound');
});

test('retirement-store failure cannot leave the closed route or its failure notification pending', async () => {
  const f = await fixture(); const first = f.install(); const sibling = f.install();
  const record = spyOn(NodeOutputRetirements.prototype, 'record').mockImplementationOnce(() => { throw new Error('synthetic retirement failure'); });
  try {
    expect(() => f.routes.retireGap({ type: 'node-replay-gap', stream: first.route.stream,
      requestedAfter: 0, firstRetainedSequence: 2, lastProducedSequence: 2 })).toThrow('synthetic retirement failure');
    expect(first.route.signal.aborted).toBe(true);
    expect(first.failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'NODE_REPLAY_GAP' }));
    expect(sibling.route.signal.aborted).toBe(false);
  } finally { record.mockRestore(); }
});

test('permission history reconstructs the capability captured for that route before synchronous publication', async () => {
  const f = await fixture();
  const occurrence = '00000000-0000-4000-8000-000000000001';
  const respond = mock(async () => {});
  const permission = mock((_handle: string, _runId: string, id: string) => ({ permissionOccurrenceId: id, respond }));
  const first = f.install(undefined, { permission }); const attempt = f.begin();
  f.ledger.beginRun(first.chatId, 'synthetic-run');
  const event: AgentProducerEvent = { type: 'permission', runId: 'synthetic-run', decision: { permissionOccurrenceId: occurrence, respond },
    lifecycle: { kind: 'requested', permissionOccurrenceId: occurrence,
      requestedTool: new BashToolUseMessage(at, 'synthetic-tool', 'pwd'), options: [{ id: 'allow', label: 'Allow' }] } };
  expect(f.routes.receive(frames(first.route, 1, event, attempt)[0]!).ack?.throughSequence).toBe(1);
  expect(permission).toHaveBeenCalledWith('synthetic-permission-handle', 'synthetic-run', occurrence);
  expect(f.ledger.currentRows(first.chatId)).toHaveLength(1);
  expect(respond).not.toHaveBeenCalled();
});

test('a source closed during installation validation leaves its identity retired without retaining publication', async () => {
  const f = await fixture(); const first = f.install();
  f.validate.mockImplementationOnce(() => {}).mockImplementationOnce(() => first.lease.close());
  expect(() => f.routes.install({ ...first.options, stream: { ...session, streamId: 'synthetic-race' } })).toThrow();
  expect(f.routes.cursors()).toEqual([]);
  expect(first.failure).not.toHaveBeenCalled();
});

test('logical closure frees assembly and reentrant retirement cannot reopen the closed owner', async () => {
  const f = await fixture(); const first = f.install(); const attempt = f.begin();
  f.routes.receive(frames(first.route, 1, row('synthetic large '.repeat(20_000)), attempt)[0]!);
  const retirement = mock(() => first.route.retire());
  first.route.signal.addEventListener('abort', retirement, { once: true });
  f.lifetime.abort();
  expect(f.budget.reservedBytes).toBe(0); expect(retirement).toHaveBeenCalledTimes(1);
  expect(() => f.routes.install(first.options)).toThrow('NODE_WORKER_CLOSED');
  expect(first.failure).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
});
