import { immediateNodeReplies } from '../reply-port.js';
import { expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import type { NodeConnectionLease } from '../../../execution-node/supervisor.js';
import { executionWireFixture } from '../../../execution-node/__tests__/execution-wire-fixture.js';
import { NodeExecutionClient, NodeExecutionServer } from '../execution-channel.js';
import { NodeSocketWriter, NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES } from '../socket-writer.js';
import { clientNodeSocketPort, serverNodeSocketPort, type NodeClientSocket } from '../bun-sockets.js';
import { MAX_NODE_EXECUTION_FRAME_BYTES } from '../execution-wire.js';
import { parseNodeExecutionReplyText } from '../execution-receipt-wire.js';

test('a lost WebSocket dispatch reply reconciles the same native occurrence through its replacement', async () => {
  const f = executionWireFixture();
  const sockets = new Set<ServerWebSocket<NodeConnectionLease>>();
  const endpoints = new Map<ServerWebSocket<NodeConnectionLease>, { channel: NodeExecutionServer; writer: NodeSocketWriter }>();
  const clients: NodeExecutionClient[] = [];
  let nextConnection = f.connection;
  let dropDispatchReply = true;
  const writerLimits = { maxFrameBytes: MAX_NODE_EXECUTION_FRAME_BYTES,
    maxBufferedBytes: 2 * MAX_NODE_EXECUTION_FRAME_BYTES - 1024, reservedControlBytes: 4096, reservedLifecycleBytes: 1024, maxDrainWaiters: 4, drainTimeoutMs: 1_000 };
  const writerOptions = (signal: AbortSignal) => ({ ...writerLimits, signal });
  const server = Bun.serve<NodeConnectionLease>({
    hostname: '0.0.0.0', port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: nextConnection })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      maxPayloadLength: MAX_NODE_EXECUTION_FRAME_BYTES,
      backpressureLimit: writerLimits.maxBufferedBytes + NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES + writerLimits.maxFrameBytes,
      closeOnBackpressureLimit: true,
      open(socket) {
        sockets.add(socket);
        const connection = socket.data;
        const writer = new NodeSocketWriter(serverNodeSocketPort(socket), writerOptions(connection.signal));
        const channel = new NodeExecutionServer(immediateNodeReplies({
          send(serialized) {
            if (dropDispatchReply && parseNodeExecutionReplyText(serialized)?.result.kind === 'dispatched') {
              dropDispatchReply = false;
              f.supervisor.disconnect(connection);
              return false;
            }
            return writer.send(serialized);
          },
          close() { writer.close(); },
        }), { execute: (command, signal) => f.adapter.execute(connection, command, signal) }, {
          session: f.session, signal: connection.signal, validate: () => f.supervisor.assertConnection(connection),
        });
        endpoints.set(socket, { channel, writer });
      },
      message(socket, data) { endpoints.get(socket)?.channel.receive(typeof data === 'string' ? data : data.toString()); },
      drain(socket) { endpoints.get(socket)?.writer.drain(); },
      close(socket) { endpoints.get(socket)?.channel.close(); endpoints.delete(socket); sockets.delete(socket); f.supervisor.disconnect(socket.data); },
    },
  });
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`) as NodeClientSocket;
    const physical = new AbortController();
    const opened = Promise.withResolvers<NodeExecutionClient>();
    let channel: NodeExecutionClient | null = null;
    socket.addEventListener('open', () => {
      channel = new NodeExecutionClient(new NodeSocketWriter(clientNodeSocketPort(socket), writerOptions(physical.signal)), {
        session: f.session, signal: physical.signal, validate() { physical.signal.throwIfAborted(); },
      });
      clients.push(channel);
      opened.resolve(channel);
    }, { once: true });
    socket.addEventListener('message', (event) => { if (typeof event.data === 'string') channel?.receive(event.data); });
    socket.addEventListener('close', () => { physical.abort(); opened.reject(new Error('Synthetic socket closed before opening')); }, { once: true });
    socket.addEventListener('error', () => { physical.abort(); opened.reject(new Error('Synthetic socket failed')); }, { once: true });
    return opened.promise;
  };
  const caller = new AbortController();
  try {
    const first = await connect();
    const prepared = await first.call({ method: 'prepare', location: f.location, request: f.request }, caller.signal);
    if (prepared.kind !== 'prepared') throw new Error('Synthetic preparation failed');
    const { identity } = prepared.ticket;
    expect(await first.call({ method: 'dispatch', identity, stream: f.stream,
      body: f.body(identity, { kind: 'execution', input: { prompt: 'synthetic input', attachments: [], carriedContext: null } }) }, caller.signal))
      .toEqual({ kind: 'unknown' });
    expect(f.execution.start).toHaveBeenCalledTimes(1);
    nextConnection = f.supervisor.attach(f.session);
    const second = await connect();
    expect(await second.call({ method: 'status', identity }, caller.signal)).toMatchObject({ kind: 'status', receipt: { phase: 'dispatched', dispatch: 'completed' } });
    expect(await second.call({ method: 'prepare', location: f.location, request: f.request }, caller.signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    expect(await second.call({ method: 'abort', identity }, caller.signal)).toEqual({ kind: 'abort-result', requested: true });
    expect(f.execution.abort).toHaveBeenCalledTimes(1);
    f.execution.start.mock.calls[0]![0].output.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
    expect(await second.call({ method: 'status', identity }, caller.signal)).toMatchObject({ kind: 'status', receipt: { phase: 'ended', abort: 'requested' } });
    f.supervisor.completeRecovery(nextConnection, f.supervisor.beginRecovery(nextConnection));
    expect(await second.call({ method: 'prepare', location: f.location, request: { ...f.request, runId: 'synthetic-next-run' } }, caller.signal))
      .toMatchObject({ kind: 'prepared', ticket: { runId: 'synthetic-next-run' } });
    expect(f.execution.start).toHaveBeenCalledTimes(1);
  } finally {
    for (const client of clients) client.close();
    for (const socket of sockets) socket.terminate();
    await server.stop(true);
    await f.dispose();
  }
}, 5_000);
