import { expect, test } from 'bun:test';
import { SessionTransport } from '../session-transport.js';

function fixture(limits: ConstructorParameters<typeof SessionTransport>[3] = {}) {
  const failures: Error[] = [];
  const delivered: string[] = [];
  const output: string[] = [];
  const transport = new SessionTransport('session', 'peer', (error) => failures.push(error), limits);
  transport.onMessage((payload) => delivered.push(payload));
  const socket = { send: (encoded: string) => { output.push(encoded); }, close() {} };
  return { transport, socket, output, delivered, failures };
}

const message = (ordinal: number, body: string) => JSON.stringify({ kind: 'message', ordinal, body });
const receipt = JSON.stringify({ kind: 'receipt', through: 0 });

test('attachment sends retained frames before its fence and consumes peer replay before ready', async () => {
  const { transport, socket, output, delivered } = fixture();
  const order: string[] = [];
  transport.onMessage((payload) => order.push(payload));
  transport.onAvailability((connected) => { if (connected) order.push('available'); });
  const ready = transport.ready.then(() => order.push('ready'));
  try {
    transport.send('retained request');
    const connection = transport.attach(socket, 0);
    expect(output.map((encoded) => JSON.parse(encoded).kind)).toEqual(['message', 'receipt']);
    expect(transport.channel.attached).toBe(true);
    expect(transport.connected).toBe(false);
    connection.receive(message(1, 'rows'));
    connection.receive(message(2, 'terminal'));
    expect(delivered).toEqual([]);
    connection.receive(receipt);
    await ready;
    expect(order).toEqual(['rows', 'terminal', 'available', 'ready']);
    expect(transport.connected).toBe(true);
  } finally { transport.close(); }
});

test('acknowledged inbound replay survives another disconnect before the fence', async () => {
  const { transport, socket, delivered } = fixture();
  try {
    const first = transport.attach(socket, 0);
    first.receive(message(1, 'rows'));
    expect(transport.channel.received).toBe(1);
    first.disconnected();
    const second = transport.attach(socket, 0);
    first.receive(receipt);
    expect(transport.connected).toBe(false);
    second.receive(message(1, 'rows'));
    second.receive(message(2, 'terminal'));
    expect(delivered).toEqual([]);
    second.receive(receipt);
    await transport.ready;
    expect(delivered).toEqual(['rows', 'terminal']);
  } finally { transport.close(); }
});

for (const limits of [{ maxRetainedFrames: 1 }, { maxRetainedBytes: 3 }]) {
  test(`inbound replay exhaustion retires rather than delivering a suffix: ${JSON.stringify(limits)}`, async () => {
    const { transport, socket, delivered, failures } = fixture(limits);
    const connection = transport.attach(socket, 0);
    connection.receive(message(1, 'row'));
    connection.receive(message(2, 'end'));
    await expect(transport.ready).rejects.toThrow('Inbound replay budget exhausted');
    connection.receive(receipt);
    expect(delivered).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(transport.channel.attached).toBe(false);
    expect(() => transport.attach(socket, 0)).toThrow('budget exhausted');
  });
}

test('a replay consumer exception prevents readiness and all later delivery', async () => {
  const { transport, socket, delivered, failures } = fixture();
  const available: boolean[] = [];
  transport.onAvailability((connected) => available.push(connected));
  transport.onMessage(() => { throw new Error('Consumer rejected row'); });
  const connection = transport.attach(socket, 0);
  connection.receive(message(1, 'rows'));
  connection.receive(message(2, 'terminal'));
  connection.receive(receipt);
  await expect(transport.ready).rejects.toThrow('Consumer rejected row');
  connection.receive(message(3, 'later'));
  expect(delivered).toEqual(['rows']);
  expect(failures).toHaveLength(1);
  expect(available).not.toContain(true);
});
