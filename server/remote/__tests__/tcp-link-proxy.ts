import { connect, createServer, type AddressInfo, type Socket } from 'node:net';

type ProxyDirection = 'toTarget' | 'fromTarget';

export interface ProxyConnection {
  readonly id: number;
  readonly connected: boolean;
  readonly received: Readonly<Record<ProxyDirection, number>>;
  throttle(bytesPerSecond: number): void;
  blackhole(): void;
  hold(direction?: ProxyDirection): void;
  restore(): void;
  disconnect(): void;
  waitForBytes(direction: ProxyDirection, minimum: number): Promise<void>;
}

/** Faults the encrypted byte stream without stopping either endpoint process. */
export async function tcpLinkProxy(target: URL) {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const paths = new Map<number, ProxyConnection>();
  let rate: number | null = null;
  let silent = false;
  let refusing = false;
  let corrupting = false;
  let connections = 0;
  const server = createServer(client => {
    if (refusing) { client.destroy(); return; }
    const id = ++connections;
    const upstream = connect(Number(target.port), target.hostname);
    sockets.add(client); sockets.add(upstream);
    const mode: { rate: number | null; silent: boolean; holding: ProxyDirection | 'both' | null } = { rate, silent, holding: null };
    const held = new Map<Socket, () => void>();
    const received = { toTarget: 0, fromTarget: 0 };
    const waiters = new Set<{ direction: ProxyDirection; minimum: number; resolve(): void; reject(error: Error): void }>();
    const payloadEnds = webSocketPayloadEnds();
    const forward = (source: Socket, destination: Socket) => {
      const direction = destination === upstream ? 'toTarget' : 'fromTarget';
      source.on('data', (chunk: Buffer) => {
        received[direction] += chunk.length;
        for (const waiter of waiters) if (received[waiter.direction] >= waiter.minimum) waiter.resolve();
        if (mode.silent) return;
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
          if (mode.holding === 'both' || mode.holding === direction) { held.set(source, flush); return; }
          if (mode.silent) { source.resume(); return; }
          const end = Math.min(chunk.length, offset + (mode.rate === null ? chunk.length : Math.max(1, Math.floor(mode.rate / 8))));
          const writable = destination.write(chunk.subarray(offset, end));
          offset = end;
          const next = () => {
            if (offset < chunk.length) flush();
            else source.resume();
          };
          if (mode.rate !== null) {
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
      paths.delete(id);
      held.clear();
      for (const waiter of waiters) waiter.reject(new Error('Captured proxy connection closed'));
      sockets.delete(client); sockets.delete(upstream);
      client.destroy(); upstream.destroy();
    };
    client.on('close', close); upstream.on('close', close);
    client.on('error', close); upstream.on('error', close);
    paths.set(id, {
      id,
      get connected() { return !client.destroyed && !upstream.destroyed; },
      get received() { return { ...received }; },
      throttle(bytesPerSecond) { mode.rate = bytesPerSecond; },
      blackhole() { mode.silent = true; },
      hold(direction) { mode.holding = direction ?? 'both'; },
      restore() {
        mode.silent = false; mode.holding = null; mode.rate = null;
        const pending = [...held.values()];
        held.clear();
        for (const flush of pending) flush();
      },
      disconnect: close,
      waitForBytes(direction, minimum) {
        if (received[direction] >= minimum) return Promise.resolve();
        if (client.destroyed || upstream.destroyed) return Promise.reject(new Error('Captured proxy connection closed'));
        return new Promise((resolve, reject) => {
          const finish = () => { clearTimeout(timer); waiters.delete(waiter); };
          const waiter = { direction, minimum, resolve() { finish(); resolve(); }, reject(error: Error) { finish(); reject(error); } };
          const timer = setTimeout(() => waiter.reject(new Error('Proxy traffic was not observed')), 5_000);
          waiters.add(waiter);
        });
      },
    });
  });
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const url = new URL(target.href);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as AddressInfo).port);
  return {
    url: url.href,
    get connections() { return connections; },
    get activeConnectionIds() { return [...paths.keys()]; },
    capture(id: number): ProxyConnection {
      const connection = paths.get(id);
      if (!connection) throw new Error(`Proxy connection ${id} is not active`);
      return connection;
    },
    throttle(bytesPerSecond: number) { rate = bytesPerSecond; for (const path of paths.values()) path.throttle(bytesPerSecond); },
    blackhole() { silent = true; for (const path of paths.values()) path.blackhole(); },
    // Flips the last payload byte of the next frame bound for the target, part of an
    // encrypted record's authentication tag, so the target fails that record.
    corruptNextToTarget() { corrupting = true; },
    restore() { silent = false; rate = null; for (const path of paths.values()) path.restore(); },
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
