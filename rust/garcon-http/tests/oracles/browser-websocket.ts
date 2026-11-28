import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { constants, deflateRawSync, inflateRawSync } from 'node:zlib';
import { PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS } from '../../../../server/controller/ws/transport.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);
const sharedLimit = 65_535;
const browserLimit = 32_768;
const budget = 16_384;
const deflateOffer = 'permessage-deflate; client_max_window_bits';
const negotiated = 'permessage-deflate; client_no_context_takeover; server_no_context_takeover';
const burstCount = 64;
const burstPayload = 'x'.repeat(256 * 1024);
let burstFinished = false;
const listen = Bun.argv[2] === 'original';
const original = listen ? Bun.serve({
  hostname: '0.0.0.0', port: 0,
  fetch(request, server) {
    if (!server.upgrade(request)) return new Response('WebSocket upgrade failed', { status: 400 });
  },
  websocket: {
    ...PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS,
    idleTimeout: 0,
    backpressureLimit: Math.max(budget, 32 * 1024 * 1024),
    closeOnBackpressureLimit: true,
    maxPayloadLength: sharedLimit,
    message(socket, message) {
      if (Buffer.byteLength(message) > browserLimit) socket.close(1009, 'Message exceeds the configured size limit');
      else if (message === 'fixture-close') socket.close(4001, 'AUTH_REVOKED');
      else if (message === 'fixture-burst') {
        for (let i = 0; i < burstCount; i++) if (!send(burstPayload)) break;
        burstFinished = true;
      } else if (message === 'fixture-burst-state') send(burstFinished ? 'finished' : 'waiting');
      else send(message);

      function send(payload: typeof message) {
        const status = socket.send(payload, true);
        if (socket.getBufferedAmount() <= budget) return status !== 0;
        socket.terminate();
        return false;
      }
    },
  },
}) : null;
const port = original?.port ?? Number(Bun.argv[2]);

class Wire {
  readonly socket: Socket;
  readonly iterator: AsyncIterator<Buffer>;
  buffer: Buffer = Buffer.alloc(0);

  constructor(head: string) {
    this.socket = createConnection({ host: '127.0.0.1', port }, () => this.socket.write(head));
    this.socket.setTimeout(6000, () => this.socket.destroy(new Error('WebSocket test timed out')));
    this.iterator = this.socket[Symbol.asyncIterator]();
  }

  async fill(): Promise<boolean> {
    try {
      const next = await this.iterator.next();
      if (next.done) return false;
      this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)]);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') return false;
      throw error;
    }
  }

  async take(count: number): Promise<Buffer | null> {
    while (this.buffer.length < count) {
      if (!await this.fill()) return null;
    }
    const selected = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return selected;
  }

  async head() {
    const delimiter = '\r\n\r\n';
    while (this.buffer.indexOf(delimiter) < 0) assert.ok(await this.fill(), 'missing handshake response');
    const length = this.buffer.indexOf(delimiter);
    const text = (await this.take(length + delimiter.length))!.toString();
    const [status, ...lines] = text.trimEnd().split('\r\n');
    const headers = new Headers(lines.map(line => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon), line.slice(colon + 1)];
    }));
    return { status, headers };
  }

  async frame(allowTruncated = false) {
    const head = await this.take(2);
    if (!head) return null;
    assert.equal(head[1]! & 128, 0, 'server frames are unmasked');
    const size = head[1]! & 127;
    const extended = size === 126 ? await this.take(2) : size === 127 ? await this.take(8) : null;
    if (size >= 126 && !extended && allowTruncated) return null;
    const length = size === 126 ? extended!.readUInt16BE() : size === 127 ? Number(extended!.readBigUInt64BE()) : size;
    const raw = await this.take(length);
    if (!raw && allowTruncated) return null;
    assert.ok(raw, 'truncated server frame');
    const compressed = (head[0]! & 0x40) !== 0;
    const data = compressed ? inflate(raw) : raw;
    return { opcode: head[0]! & 15, compressed, raw, data };
  }
}

function mask(opcode: number, payload: Buffer, flags = 0x80): Buffer {
  const size = payload.length;
  const n = size < 126 ? 0 : size <= 65535 ? 2 : 8;
  const result = Buffer.alloc(6 + n + size);
  result[0] = flags | opcode;
  result[1] = 0x80 | (n === 0 ? size : n === 2 ? 126 : 127);
  if (n === 2) result.writeUInt16BE(size, 2);
  if (n === 8) result.writeBigUInt64BE(BigInt(size), 2);
  const key = [1, 2, 3, 4];
  for (let i = 0; i < key.length; i++) result[2 + n + i] = key[i]!;
  for (let i = 0; i < size; i++) result[6 + n + i] = payload[i]! ^ key[i % 4]!;
  return result;
}

function compress(payload: Buffer, dictionary?: Buffer): Buffer {
  const compressed = deflateRawSync(payload, { finishFlush: constants.Z_SYNC_FLUSH, dictionary });
  assert.deepEqual(compressed.subarray(-4), Buffer.from([0, 0, 255, 255]));
  return compressed.subarray(0, -4);
}

function inflate(raw: Buffer): Buffer {
  return inflateRawSync(Buffer.concat([raw, Buffer.from([0, 0, 255, 255])]), { finishFlush: constants.Z_SYNC_FLUSH });
}

function connect(extension?: string, connection: string | null = 'Upgrade', version = '1.1'): Wire {
  return new Wire([
    `GET /ws HTTP/${version}`, 'Host: localhost', 'Upgrade: websocket',
    'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ...(connection === null ? [] : [`Connection: ${connection}`]),
    ...(extension ? [`Sec-WebSocket-Extensions: ${extension}`] : []), '', '',
  ].join('\r\n'));
}

async function open(extension?: string) {
  const wire = connect(extension);
  const { status } = await wire.head();
  assert.match(status, / 101 /);
  return wire;
}

async function expectClose(wire: Wire, bytes: Buffer, expected: [number, string] | null) {
  try {
    wire.socket.write(bytes);
    const frame = await wire.frame();
    if (!expected) assert.equal(frame, null, 'transport must end without a close frame');
    else {
      assert.ok(frame, 'missing close frame');
      assert.equal(frame.opcode, 8);
      assert.equal(frame.data.readUInt16BE(), expected[0]);
      assert.equal(frame.data.subarray(2).toString(), expected[1]);
    }
  } finally { wire.socket.destroy(); }
}

async function expectSlowBrowserDropped() {
  const slow = await open();
  const healthy = await open();
  try {
    slow.socket.pause();
    slow.socket.write(mask(1, Buffer.from('fixture-burst')));
    // Leave the reader paused until the server attempted the entire burst.
    const status = mask(1, Buffer.from('fixture-burst-state'));
    const deadline = performance.now() + 4000;
    for (;;) {
      healthy.socket.write(status);
      const message = (await healthy.frame())?.data.toString();
      if (message === 'finished') break;
      assert.equal(message, 'waiting');
      assert.ok(performance.now() < deadline, 'server did not finish the burst');
    }

    const ping = Buffer.from('healthy');
    healthy.socket.write(mask(9, ping));
    const pong = await healthy.frame();
    assert.equal(pong?.opcode, 10);
    assert.deepEqual(pong?.data, ping);

    let delivered = 0;
    for (let frame = await slow.frame(true); frame; frame = await slow.frame(true)) {
      assert.equal(frame.opcode, 1, 'the slow browser is dropped without a close handshake');
      assert.ok(++delivered < burstCount, 'the slow browser received every reply');
    }

    const replacement = await open();
    replacement.socket.destroy();
  } finally {
    slow.socket.destroy();
    healthy.socket.destroy();
  }
}

try {
  for (const offer of ['permessage-deflate', deflateOffer, 'permessage-deflate; client_max_window_bits=12', 'x-unknown, permessage-deflate; server_max_window_bits=10']) {
    const wire = connect(offer);
    const response = await wire.head();
    assert.match(response.status, / 101 /);
    assert.equal(response.headers.get('sec-websocket-extensions'), negotiated);
    wire.socket.destroy();
  }
  for (const connection of [null, 'keep-alive']) {
    const wire = connect(undefined, connection);
    assert.match((await wire.head()).status, / 101 /);
    wire.socket.destroy();
  }
  {
    const wire = connect(undefined, 'Upgrade', '1.0');
    assert.match((await wire.head()).status, listen ? / 101 / : / 400 /);
    wire.socket.destroy();
  }
  {
    const wire = await open(deflateOffer);
    const data = Buffer.alloc(browserLimit, 'x');
    const compressed = compress(data);
    const half = compressed.length >>> 1;
    wire.socket.write(mask(1, compressed, 0xc0));
    wire.socket.write(Buffer.concat([mask(1, compressed.subarray(0, half), 0x40), mask(0, compressed.subarray(half))]));
    const one = await wire.frame();
    const two = await wire.frame();
    assert.equal(one?.opcode, 1);
    assert.equal(two?.opcode, 1);
    assert.equal(one?.compressed, true);
    assert.equal(two?.compressed, true);
    assert.deepEqual(one?.data, data);
    assert.deepEqual(two?.data, data);
    assert.deepEqual(one?.raw, two?.raw, 'no context is retained across replies');
    wire.socket.write(mask(9, Buffer.from('control-ping')));
    const pong = await wire.frame();
    assert.equal(pong?.opcode, 10);
    assert.equal(pong?.data.toString(), 'control-ping');
    await expectClose(wire, mask(1, Buffer.from('fixture-close')), [4001, 'AUTH_REVOKED']);
  }
  {
    const wire = await open(deflateOffer);
    const first = Buffer.from(Array.from({ length: 32 }, (_, i) => createHash('sha256').update(String(i)).digest('hex')).join(''));
    const second = compress(first, first);
    assert.throws(() => inflate(second), 'second message requires the first message as a dictionary');
    wire.socket.write(mask(1, compress(first), 0xc0));
    assert.deepEqual((await wire.frame())?.data, first);
    await expectClose(wire, mask(1, second, 0xc0), null);
  }
  await expectClose(await open(), mask(1, Buffer.alloc(browserLimit + 1, 'x')), [1009, 'Message exceeds the configured size limit']);
  await expectClose(await open(), mask(1, Buffer.alloc(sharedLimit, 'x')), [1009, 'Message exceeds the configured size limit']);
  await expectClose(await open(), mask(1, Buffer.alloc(sharedLimit + 1, 'x')), null);
  await expectClose(await open(), Buffer.concat([mask(1, Buffer.alloc(32768, 'x'), 0), mask(0, Buffer.alloc(32768, 'x'))]), null);
  await expectClose(await open(deflateOffer), mask(1, compress(Buffer.alloc(sharedLimit + 1, 'x')), 0xc0), null);
  await expectClose(await open(), mask(1, Buffer.from([0xff])), null);
  await expectSlowBrowserDropped();
  console.log(`${listen ? 'Bun' : 'Rust'} WebSocket transport: handshake, deflate, limits, ping/pong, close, backpressure passed`);
} finally {
  if (original) await original.stop(true);
}
