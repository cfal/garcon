import { connect, createServer, type AddressInfo, type Socket } from 'node:net';

/** Faults the encrypted byte stream without stopping either endpoint process. */
export async function tcpLinkProxy(target: URL) {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let rate: number | null = null;
  let silent = false;
  let refusing = false;
  let corrupting = false;
  let connections = 0;
  const server = createServer(client => {
    if (refusing) { client.destroy(); return; }
    connections++;
    const upstream = connect(Number(target.port), target.hostname);
    sockets.add(client); sockets.add(upstream);
    const payloadEnds = webSocketPayloadEnds();
    const forward = (source: Socket, destination: Socket) => {
      source.on('data', (chunk: Buffer) => {
        if (silent) return;
        if (destination === upstream) {
          const [end] = payloadEnds(chunk);
          if (corrupting && end !== undefined) {
            corrupting = false;
            chunk = Buffer.from(chunk);
            chunk[end]! ^= 0xff;
          }
        }
        source.pause();
        let offset = 0;
        const flush = () => {
          if (source.destroyed || destination.destroyed) return;
          if (silent) { source.resume(); return; }
          const end = Math.min(chunk.length, offset + (rate === null ? chunk.length : Math.max(1, Math.floor(rate / 8))));
          const writable = destination.write(chunk.subarray(offset, end));
          offset = end;
          const next = () => {
            if (offset < chunk.length) flush();
            else source.resume();
          };
          if (rate !== null) {
            const timer = setTimeout(() => { timers.delete(timer); next(); }, 125);
            timers.add(timer);
          } else if (writable) next();
          else destination.once('drain', next);
        };
        flush();
      });
    };
    forward(client, upstream); forward(upstream, client);
    const close = () => {
      sockets.delete(client); sockets.delete(upstream);
      client.destroy(); upstream.destroy();
    };
    client.on('close', close); upstream.on('close', close);
    client.on('error', close); upstream.on('error', close);
  });
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const url = new URL(target.href);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as AddressInfo).port);
  return {
    url: url.href,
    get connections() { return connections; },
    throttle(bytesPerSecond: number) { rate = bytesPerSecond; },
    blackhole() { silent = true; },
    // Flips the last payload byte of the next frame bound for the target, part of an
    // encrypted record's authentication tag, so the target fails that record.
    corruptNextToTarget() { corrupting = true; },
    restore() { silent = false; rate = null; },
    // Keeps a lost link down: redials are closed until connections are accepted again.
    refuseConnections() { refusing = true; },
    acceptConnections() { refusing = false; },
    disconnect() { for (const socket of sockets) socket.destroy(); },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

// Follows WebSocket frames in the client-to-target stream after the HTTP upgrade
// and returns the chunk offsets where frame payloads end. TCP chunks need not
// align with frames, so a byte chosen by chunk position could be a frame header.
function webSocketPayloadEnds(): (chunk: Buffer) => number[] {
  let handshake: Buffer | null = Buffer.alloc(0);
  let header: number[] = [];
  let headerLength = 2;
  let payloadLeft = 0;
  return (chunk) => {
    const ends: number[] = [];
    let offset = 0;
    if (handshake) {
      const seen = Buffer.concat([handshake, chunk]);
      const end = seen.indexOf('\r\n\r\n');
      if (end < 0) {
        handshake = seen;
        return ends;
      }
      offset = end + 4 - handshake.length;
      handshake = null;
    }
    while (offset < chunk.length) {
      if (payloadLeft > 0) {
        const taken = Math.min(payloadLeft, chunk.length - offset);
        payloadLeft -= taken;
        offset += taken;
        if (payloadLeft === 0) ends.push(offset - 1);
        continue;
      }
      header.push(chunk[offset]!);
      offset += 1;
      if (header.length === 2) {
        const maskBytes = header[1]! & 0x80 ? 4 : 0;
        headerLength = 2 + extendedLengthBytes(header[1]!) + maskBytes;
      }
      if (header.length === headerLength) {
        payloadLeft = payloadLength(header);
        header = [];
      }
    }
    return ends;
  };
}

function extendedLengthBytes(secondByte: number): number {
  const length = secondByte & 0x7f;
  if (length === 126) return 2;
  if (length === 127) return 8;
  return 0;
}

function payloadLength(header: readonly number[]): number {
  const length = header[1]! & 0x7f;
  if (length === 126) return (header[2]! << 8) | header[3]!;
  if (length === 127) return Number(Buffer.from(header.slice(2, 10)).readBigUInt64BE());
  return length;
}
