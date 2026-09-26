import { expect, mock, test } from 'bun:test';
import { ExecutorRpc } from '../rpc.js';
import { SessionTransport } from '../session-transport.js';

function fixture() {
  const sent: Array<{ type: string; id: string }> = [];
  const transport = new SessionTransport('session', 'worker', () => {});
  const connection = transport.attach({
    send: (payload) => { sent.push(JSON.parse(payload)); },
    close() {},
  });
  return { rpc: new ExecutorRpc(transport), connection, sent, transport };
}

test('cancelled calls retain bounded cleanup until settlement and release budget before cleanup', async () => {
  const { rpc, connection, sent, transport } = fixture();
  try {
    const cancelled = new AbortController();
    const cleaned = Promise.withResolvers<void>();
    const onLateResult = mock(async () => {
      const call = rpc.call('test', 'execution.runningSessions', null);
      connection.receive(JSON.stringify({ type: 'result', id: sent.at(-1)!.id, value: [] }));
      await call;
      cleaned.resolve();
    });
    const calls = Array.from({ length: 256 }, () => rpc.call('test', 'execution.runningSessions', null, {
      signal: cancelled.signal, onLateResult,
    }).catch((error: unknown) => error));
    const ids = sent.map(({ id }) => id);
    cancelled.abort();
    for (const call of calls) expect(await call).toMatchObject({ outcome: 'unknown' });
    await expect(rpc.call('test', 'execution.runningSessions', null)).rejects.toMatchObject({ outcome: 'not-dispatched' });
    connection.receive(JSON.stringify({ type: 'result', id: ids[0], value: [] }));
    await cleaned.promise;
    expect(onLateResult).toHaveBeenCalledTimes(1);
    connection.receive(JSON.stringify({ type: 'result', id: ids[0], value: [] }));
    expect(onLateResult).toHaveBeenCalledTimes(1);
    connection.receive(JSON.stringify({ type: 'error', id: ids[1], error: {
      code: 'PROVIDER_FAILURE', message: 'cancelled', retryable: false,
    } }));
    const admitted = rpc.call('test', 'execution.runningSessions', null);
    connection.receive(JSON.stringify({ type: 'result', id: sent.at(-1)!.id, value: [] }));
    await expect(admitted).resolves.toEqual([]);
    expect(onLateResult).toHaveBeenCalledTimes(1);
  } finally { transport.close(); }
});

test('normal results and cancellation before dispatch never invoke late cleanup', async () => {
  const { rpc, connection, sent, transport } = fixture();
  try {
    const onLateResult = mock(() => {});
    await expect(rpc.call('test', 'execution.runningSessions', null, {
      signal: AbortSignal.abort(), onLateResult,
    })).rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(sent).toHaveLength(0);
    const call = rpc.call('test', 'execution.runningSessions', null, { onLateResult });
    connection.receive(JSON.stringify({ type: 'result', id: sent[0]!.id, value: [] }));
    await expect(call).resolves.toEqual([]);
    expect(onLateResult).not.toHaveBeenCalled();
  } finally { transport.close(); }
});

test('deadline cancellation cleans up a late result', async () => {
  const { rpc, connection, sent, transport } = fixture();
  try {
    const cleaned = Promise.withResolvers<unknown>();
    await expect(rpc.call('test', 'execution.runningSessions', null, {
      timeoutMs: 1, onLateResult: (value) => { cleaned.resolve(value); },
    })).rejects.toMatchObject({ outcome: 'unknown' });
    connection.receive(JSON.stringify({ type: 'result', id: sent[0]!.id, value: [] }));
    expect(await cleaned.promise).toEqual([]);
  } finally { transport.close(); }
});

test('retirement drops late cleanup, including a result queued immediately before retirement', async () => {
  const { rpc, connection, sent, transport } = fixture();
  const onLateResult = mock(() => {});
  const cancelled = new AbortController();
  const calls = Array.from({ length: 2 }, () => rpc.call('test', 'execution.runningSessions', null, {
    signal: cancelled.signal, onLateResult,
  }).catch((error: unknown) => error));
  cancelled.abort();
  await Promise.all(calls);
  connection.receive(JSON.stringify({ type: 'result', id: sent[0]!.id, value: [] }));
  transport.close();
  connection.receive(JSON.stringify({ type: 'result', id: sent[1]!.id, value: [] }));
  await Promise.resolve();
  expect(onLateResult).not.toHaveBeenCalled();
});
