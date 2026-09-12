import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NodeExecutionBodyGrants } from '../execution-body-grants.js';
import { NodeBulkTransfers } from '../../execution-nodes/transport/bulk-transfers.js';
import { MAX_NODE_EXECUTION_BODY_BYTES, serializeNodeExecutionBody } from '../../execution-nodes/transport/execution-body-wire.js';
import { NodeExecutionWireAdapter } from '../execution-wire-adapter.js';
import { executionWireFixture } from './execution-wire-fixture.js';

function descriptor(bytes: Uint8Array) {
  return { byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function fixture() {
  const f = executionWireFixture(2, 20);
  let now = 0;
  const transfers = new NodeBulkTransfers({ session: f.session, authoritySignal: f.connection.authoritySignal, now: () => now,
    limits: { maxTransfers: 2, retentionMs: 100 }, scheduleTimeout: () => ({ cancel() {} }) });
  const grants = new NodeExecutionBodyGrants({ session: f.session, signal: f.connection.authoritySignal, transfers, maxOperations: 1 });
  const ticket = await f.prepare();
  const grant = f.table.capture(f.connection, ticket.identity);
  grants.install(grant);
  const bytes = new TextEncoder().encode('synthetic private input');
  return { ...f, operation: ticket.identity, grant, transfers, grants, bytes,
    advance() { now += 100; }, async close() { grants.close(); transfers.close(); await f.dispose(); } };
}

test('verified body bytes can be consumed exactly once under their installed operation', async () => {
  const f = await fixture();
  try {
    const body = f.grants.reserve(f.operation, 'execution', null, descriptor(f.bytes), f.connection.signal);
    f.transfers.append(body, 0, f.bytes);
    expect(() => f.grants.takeBody(body, f.operation, 'execution', null)).toThrow('incomplete');
    f.transfers.complete(body);
    const received = f.grants.takeBody(body, f.operation, 'execution', null);
    expect(received).toEqual(f.bytes);
    expect(f.transfers.reservedBytes).toBe(0);
    expect(() => f.grants.takeBody(body, f.operation, 'execution', null)).toThrow('unavailable');
    received.fill(0);
  } finally { await f.close(); }
});

test.each(['operation', 'kind', 'control', 'session'] as const)('a completed upload cannot cross its %s grant', async (mismatch) => {
  const f = await fixture();
  try {
    const other = { ...f.operation, operationId: 'synthetic-other' };
    const body = f.grants.reserve(f.operation, 'execution', null, descriptor(f.bytes), f.connection.signal);
    f.transfers.append(body, 0, f.bytes); f.transfers.complete(body);
    expect(() => f.grants.takeBody(
      mismatch === 'session' ? { ...body, logicalSessionId: 'synthetic-foreign' } : body,
      mismatch === 'operation' ? other : f.operation,
      mismatch === 'kind' ? 'steer' : 'execution',
      mismatch === 'kind' || mismatch === 'control' ? 'synthetic-other' : null,
    )).toThrow('unavailable');
    expect(f.grants.takeBody(body, f.operation, 'execution', null)).toEqual(f.bytes);
  } finally { await f.close(); }
});

test('revocation releases partial and complete private uploads and never rebinds their operation', async () => {
  const f = await fixture();
  try {
    const bodies = [0, 1].map(() => f.grants.reserve(f.operation, 'execution', null, descriptor(f.bytes), f.connection.signal));
    f.transfers.append(bodies[0]!, 0, f.bytes); f.transfers.complete(bodies[0]!);
    f.transfers.append(bodies[1]!, 0, f.bytes.subarray(0, 2));
    f.table.release(f.connection, f.operation);
    expect(f.transfers.reservedBytes).toBe(0);
    expect(f.transfers.transferCount).toBe(0);
    expect(() => f.grants.takeBody(bodies[0]!, f.operation, 'execution', null)).toThrow();
    expect(() => f.grants.install(f.grant)).toThrow('cannot be rebound');
  } finally { await f.close(); }
});

test('upload cancellation and expiry free transfer capacity without granting dispatch', async () => {
  const f = await fixture();
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const cancelled = f.grants.reserve(f.operation, 'execution', null, descriptor(f.bytes), f.connection.signal);
      f.grants.cancel(cancelled);
      const expired = f.grants.reserve(f.operation, 'execution', null, descriptor(f.bytes), f.connection.signal);
      f.advance(); f.grants.prune();
      expect(f.transfers.reservedBytes).toBe(0);
      expect(() => f.grants.takeBody(expired, f.operation, 'execution', null)).toThrow('unavailable');
    }
  } finally { await f.close(); }
});

test.each(['cancel', 'caller', 'expire'] as const)('%s retires only the exact control upload, including completed bytes', async (action) => {
  for (const complete of [false, true]) {
    const f = await fixture();
    try {
      await f.table.dispatch(f.connection, f.operation, { prompt: 'synthetic input', attachments: [], carriedContext: null },
        { signal: f.connection.authoritySignal, emit() {} });
      const goal = f.grants.reserve(f.operation, 'goal', null, descriptor(f.bytes), f.connection.signal);
      const caller = new AbortController();
      const preparation = await f.table.prepareSteer(f.connection, f.operation, caller.signal);
      if (preparation.kind !== 'ready') throw new Error('Synthetic steer preparation failed');
      const controlId = preparation.ticket.controlId;
      const body = f.grants.reserve(f.operation, 'steer', controlId, descriptor(f.bytes), f.connection.signal);
      f.transfers.append(body, 0, complete ? f.bytes : f.bytes.subarray(0, 2));
      if (complete) f.transfers.complete(body);
      expect(f.transfers.transferCount).toBe(2);
      if (action === 'cancel') expect(f.table.cancelControl(f.connection, f.operation, controlId)).toBe(true);
      else if (action === 'caller') caller.abort();
      else { f.advanceClock(20); f.table.poll(); }
      expect(f.transfers.status(body)).toBeNull();
      expect(f.transfers.reservedBytes).toBe(f.bytes.byteLength);
      expect(f.transfers.transferCount).toBe(1);
      expect(f.transfers.status(goal)?.phase).toBe('receiving');
      expect(() => f.grants.takeBody(body, f.operation, 'steer', controlId)).toThrow();
      expect(f.grant.signal.aborted).toBe(false);
      expect(f.execution.abort).not.toHaveBeenCalled();

      const successor = await f.table.prepareSteer(f.connection, f.operation, f.connection.signal);
      if (successor.kind !== 'ready') throw new Error('Synthetic successor preparation failed');
      const next = f.grants.reserve(f.operation, 'steer', successor.ticket.controlId, descriptor(f.bytes), f.connection.signal);
      expect(() => f.table.cancelControl(f.connection, f.operation, controlId)).toThrow();
      f.transfers.append(next, 0, f.bytes); f.transfers.complete(next);
      expect(f.grants.takeBody(next, f.operation, 'steer', successor.ticket.controlId)).toEqual(f.bytes);
      expect(f.transfers.transferCount).toBe(1);
    } finally { await f.close(); }
  }
});

test('retired preparation and oversized bodies reject before allocation', async () => {
  const f = await fixture();
  try {
    expect(() => f.grants.reserve(f.operation, 'execution', null, { ...descriptor(f.bytes), byteLength: MAX_NODE_EXECUTION_BODY_BYTES + 1 }, f.connection.signal)).toThrow('descriptor');
    expect(f.transfers.reservedBytes).toBe(0);
    f.table.release(f.connection, f.operation);
    expect(() => f.grants.reserve(f.operation, 'execution', null, descriptor(f.bytes), f.connection.signal)).toThrow();
    expect(f.transfers.reservedBytes).toBe(0);
  } finally { await f.close(); }
});

test('wire dispatch consumes the production body grant only for its existing execution ticket', async () => {
  const f = executionWireFixture();
  const grants = new NodeExecutionBodyGrants({ session: f.session, signal: f.connection.authoritySignal, transfers: f.transfers });
  try {
    const ticket = await f.prepare();
    grants.install(f.table.capture(f.connection, ticket.identity));
    const bytes = serializeNodeExecutionBody({ kind: 'execution', input: { prompt: 'synthetic input', attachments: [], carriedContext: null } });
    const body = grants.reserve(ticket.identity, 'execution', null, descriptor(bytes), f.connection.signal);
    f.transfers.append(body, 0, bytes); f.transfers.complete(body);
    const adapter = new NodeExecutionWireAdapter(f.table, f.supervisor, {
      takeBody: (...args) => grants.takeBody(...args), output: () => ({ signal: f.connection.authoritySignal, emit() {} }),
    });
    expect(await adapter.execute(f.connection, { method: 'dispatch', identity: ticket.identity, stream: f.stream, body }, f.connection.signal)).toEqual({ kind: 'dispatched' });
    expect(f.execution.start).toHaveBeenCalledTimes(1);
    expect(f.execution.start.mock.calls[0]![0].prompt).toBe('synthetic input');
    expect(f.transfers.reservedBytes).toBe(0);
  } finally { grants.close(); await f.dispose(); }
});

test('retirement frees body operation capacity without accepting fabricated or previously consumed grants', async () => {
  const f = await fixture();
  try {
    expect(() => f.grants.install({ ...f.grant })).toThrow('issued operation grant');
    for (let index = 0; index < 8; index += 1) {
      const prepared = await f.prepare();
      const next = f.table.capture(f.connection, prepared.identity);
      expect(f.table.capture(f.connection, prepared.identity)).toBe(next);
      if (index === 0) {
        expect(() => f.grants.install(next)).toThrow('capacity');
        f.grants.retire(f.operation);
        expect(() => f.grants.install(f.grant)).toThrow('cannot be rebound');
        f.table.release(f.connection, f.operation);
      }
      f.grants.install(next);
      f.table.release(f.connection, prepared.identity);
      expect(() => f.grants.install(next)).toThrow('cannot be rebound');
      expect(() => f.table.capture(f.connection, prepared.identity)).toThrow();
    }
  } finally { await f.close(); }
});
