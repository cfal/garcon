import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { serializeNodeExecutionBody } from '../../execution-nodes/transport/execution-body-wire.js';
import { NodeExecutionHost } from '../execution-host.js';
import { executionWireFixture } from './execution-wire-fixture.js';

test('logical authority retirement closes installed host grants without throwing from abort listeners', async () => {
  const f = executionWireFixture();
  const host = new NodeExecutionHost(f.connection, f.supervisor, f.table);
  try {
    host.installStream(f.stream, f.connection.authoritySignal, () => ({ forOperation: () => ({ emit() {} }) }));
    const result = await host.execute(f.connection, { method: 'prepare', location: f.location, request: f.request }, f.connection.signal);
    if (result.kind !== 'prepared') throw new Error('Synthetic host preparation failed');
    host.bindOutput(f.connection, result.ticket.identity, f.stream);
    await f.supervisor.shutdown();
    expect(f.connection.authoritySignal.aborted).toBe(true);
    expect(() => host.bindOutput(f.connection, result.ticket.identity, f.stream)).toThrow();
  } finally { host.close(); await f.dispose(); }
});

test('one publisher spans sequential operations and physical reconnect without retaining retired grants', async () => {
  const f = executionWireFixture();
  const host = new NodeExecutionHost(f.connection, f.supervisor, f.table);
  let connection = f.connection;
  try {
    host.installStream(f.stream, connection.authoritySignal, () => ({ forOperation: () => ({ emit() {} }) }));
    for (let index = 0; index < 12; index += 1) {
      if (index === 6) {
        connection = f.supervisor.attach(f.session);
        f.supervisor.completeRecovery(connection, f.supervisor.beginRecovery(connection));
      }
      const runId = `synthetic-run-${index}`;
      const result = await host.execute(connection, { method: 'prepare', location: f.location, request: { ...f.request, runId } }, connection.signal);
      if (result.kind !== 'prepared') throw new Error('Synthetic host preparation failed');
      const { identity } = result.ticket;
      host.bindOutput(connection, identity, f.stream);
      const bytes = serializeNodeExecutionBody({ kind: 'execution', input: { prompt: 'synthetic input', attachments: [], carriedContext: null } });
      const body = host.bodies.reserve(identity, 'execution', null,
        { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, connection.signal);
      host.transfers.append(body, 0, bytes); host.transfers.complete(body);
      expect(await host.execute(connection, { method: 'dispatch', identity, stream: f.stream, body }, connection.signal)).toEqual({ kind: 'dispatched' });
      f.execution.start.mock.calls.at(-1)![0].output.emit({ type: 'run-ended', runId, outcome: 'finished' });
      expect(await host.execute(connection, { method: 'status', identity }, connection.signal)).toMatchObject({ kind: 'status', receipt: { phase: 'ended' } });
      expect(host.transfers.reservedBytes).toBe(0);
      expect(f.occupancy.active).toBe(1);
      await f.settleNative(index);
      expect(f.occupancy.active).toBe(0);
    }
    expect(f.execution.start).toHaveBeenCalledTimes(12);
  } finally { host.close(); await f.dispose(); }
});
