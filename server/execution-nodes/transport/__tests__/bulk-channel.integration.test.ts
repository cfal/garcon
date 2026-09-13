import { expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { NodeBulkChannel } from '../bulk-channel.js';
import { NodeBulkTransfers } from '../bulk-transfers.js';
import { NodeBulkUploads } from '../bulk-upload.js';
import { MAX_NODE_BULK_CHUNK_BYTES, MAX_NODE_BULK_FRAME_BYTES } from '../bulk-wire.js';
import { clientNodeSocketPort, serverNodeSocketPort, type NodeClientSocket } from '../bun-sockets.js';
import { NodeSocketWriter, NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES } from '../socket-writer.js';

test.each(['drain', 'credit'] as const)('real bulk channels transfer both ways with %s while control stays responsive', async (delivery) => {
  const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
  const authority = new AbortController();
  const physical = new AbortController();
  const writerOptions = { signal: physical.signal, maxFrameBytes: MAX_NODE_BULK_FRAME_BYTES,
    maxBufferedBytes: 1024 * 1024 - 1024, reservedControlBytes: 4096, reservedLifecycleBytes: 1024, maxDrainWaiters: 32, drainTimeoutMs: 2_000 };
  const owner = Object.freeze({});
  const nodeTransfers = new NodeBulkTransfers({ session, authoritySignal: authority.signal });
  const controllerTransfers = new NodeBulkTransfers({ session, authoritySignal: authority.signal });
  const nodeOpened = Promise.withResolvers<ServerWebSocket<{ kind: 'control' | 'bulk' }>>();
  let nodeChannel: NodeBulkChannel | null = null;
  let nodeWriter: NodeSocketWriter | null = null;
  const server = Bun.serve<{ kind: 'control' | 'bulk' }>({
    hostname: '0.0.0.0', port: 0,
    fetch(request, server) {
      const kind = new URL(request.url).pathname === '/bulk' ? 'bulk' : 'control';
      if (server.upgrade(request, { data: { kind } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      backpressureLimit: writerOptions.maxBufferedBytes + NODE_SOCKET_PROTOCOL_ALLOWANCE_BYTES + writerOptions.maxFrameBytes,
      closeOnBackpressureLimit: true, maxPayloadLength: MAX_NODE_BULK_FRAME_BYTES,
      open(socket) { if (socket.data.kind === 'bulk') nodeOpened.resolve(socket); },
      message(socket, text) {
        if (socket.data.kind === 'control') socket.send(text);
        else nodeChannel?.receive(text.toString());
      },
      drain(socket) { if (socket.data.kind === 'bulk') nodeWriter?.drain(); },
      close(socket) { if (socket.data.kind === 'bulk') physical.abort(); },
    },
  });
  const bulk = new WebSocket(`ws://127.0.0.1:${server.port}/bulk`) as NodeClientSocket;
  const control = new WebSocket(`ws://127.0.0.1:${server.port}/control`) as NodeClientSocket;
  let controllerChannel: NodeBulkChannel | null = null;
  const open = (socket: NodeClientSocket) => new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('Synthetic socket failed')), { once: true });
  });
  bulk.addEventListener('message', (event) => controllerChannel?.receive(String(event.data)));
  bulk.addEventListener('close', () => physical.abort());
  const channelOptions = { session, signal: physical.signal, validate() { authority.signal.throwIfAborted(); } };
  try {
    await Promise.all([open(bulk), open(control)]);
    nodeWriter = new NodeSocketWriter(serverNodeSocketPort(await nodeOpened.promise), writerOptions);
    const controllerWriter = new NodeSocketWriter(clientNodeSocketPort(bulk), writerOptions);
    nodeChannel = new NodeBulkChannel(nodeWriter, {
      append: (identity, offset, bytes) => { nodeTransfers.append(identity, offset, bytes); },
      complete: (identity) => { nodeTransfers.complete(identity); },
      cancel: (identity) => nodeTransfers.cancel(identity, owner),
    }, channelOptions);
    controllerChannel = new NodeBulkChannel(controllerWriter, {
      append: (identity, offset, bytes) => { controllerTransfers.append(identity, offset, bytes); },
      complete: (identity) => { controllerTransfers.complete(identity); },
      cancel: (identity) => controllerTransfers.cancel(identity, owner),
    }, channelOptions);
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const toNode = new NodeBulkUploads({
      async reserve(descriptor) { return nodeTransfers.reserve(owner, descriptor, authority.signal); },
      async sendChunk(text, signal) { await (delivery === 'credit' ? controllerChannel!.sendChunkWithCredit(text, signal) : controllerChannel!.sendChunk(text, signal)); blocked.resolve(); await release.promise; },
      complete: (identity, signal) => controllerChannel!.complete(identity, signal),
      cancel: (identity) => controllerChannel!.cancel(identity),
    }, { session, authoritySignal: authority.signal });
    const body = new Uint8Array(MAX_NODE_BULK_CHUNK_BYTES * 3).fill(42);
    const uploading = toNode.upload(body, authority.signal);
    const ping = Promise.withResolvers<string>();
    control.addEventListener('message', (event) => ping.resolve(String(event.data)), { once: true });
    try {
      await blocked.promise;
      control.send('synthetic-liveness-challenge');
      expect(await ping.promise).toBe('synthetic-liveness-challenge');
    } finally { release.resolve(); }
    const received = await uploading;
    expect(nodeTransfers.take(received.identity, owner)).toEqual(body);
    const toController = new NodeBulkUploads({
      async reserve(descriptor) { return controllerTransfers.reserve(owner, descriptor, authority.signal); },
      sendChunk: (text, signal) => delivery === 'credit' ? nodeChannel!.sendChunkWithCredit(text, signal) : nodeChannel!.sendChunk(text, signal),
      complete: (identity, signal) => nodeChannel!.complete(identity, signal),
      cancel: (identity) => nodeChannel!.cancel(identity),
    }, { session, authoritySignal: authority.signal });
    const reply = await toController.upload(body, authority.signal);
    expect(controllerTransfers.take(reply.identity, owner)).toEqual(body);
    const bodies = Array.from({ length: 32 }, (_, index) => new Uint8Array(MAX_NODE_BULK_CHUNK_BYTES * 3 + index).fill(index));
    await Promise.all(bodies.flatMap((bytes) => [
      toNode.upload(bytes, authority.signal).then((result) => { expect(nodeTransfers.take(result.identity, owner)).toEqual(bytes); }),
      toController.upload(bytes, authority.signal).then((result) => { expect(controllerTransfers.take(result.identity, owner)).toEqual(bytes); }),
    ]));
    expect(nodeTransfers.reservedBytes + controllerTransfers.reservedBytes).toBe(0);
  } finally {
    authority.abort(); physical.abort();
    controllerChannel?.close(); nodeChannel?.close();
    nodeTransfers.close(); controllerTransfers.close();
    bulk.terminate(); control.terminate();
    await server.stop(true);
  }
}, 5_000);
