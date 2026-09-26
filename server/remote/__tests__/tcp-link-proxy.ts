import { connect, createServer, type AddressInfo, type Socket } from 'node:net';

/** Faults the encrypted byte stream without stopping either endpoint process. */
export async function tcpLinkProxy(target: URL) {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let rate: number | null = null;
  let silent = false;
  let connections = 0;
  const server = createServer(client => {
    connections++;
    const upstream = connect(Number(target.port), target.hostname);
    sockets.add(client); sockets.add(upstream);
    const forward = (source: Socket, destination: Socket) => {
      source.on('data', (chunk: Buffer) => {
        if (silent) return;
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
    restore() { silent = false; rate = null; },
    disconnect() { for (const socket of sockets) socket.destroy(); },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
