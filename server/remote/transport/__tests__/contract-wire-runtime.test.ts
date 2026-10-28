import { expect, test } from 'bun:test';
import { RPC_V1 } from '@garcon/common/executor-contracts';
import { parseCliContext, parseCliIdentity } from '@garcon/common/server-runtime';
import { parseTerminalStreamServerMessage } from '@garcon/common/terminal';
import { parseCliHttpResponse } from '../cli-protocol.js';
import { encodeFailure, decodeFailure, type Failure } from '../rpc-failure.js';
import { rpcWireV1 } from '../rpc-wire-v1.js';
import { ExecutorRpc } from '../rpc.js';
import { WorkerSessionTransport, TestSessionTransport, handleTestRpc } from '../../__tests__/test-session-transport.js';
import bootstrap from './fixtures/bootstrap-1-errors.json';
import cliBootstrap from './fixtures/cli-bootstrap-1.json';
import identity from './fixtures/runtime/controllerCli.describe@1.json';

test('CLI context and identity-only reverse describe have distinct frozen shapes', () => {
  expect(parseCliContext(cliBootstrap.context)).toEqual(cliBootstrap.context);
  expect(parseCliIdentity(identity.identity)).toEqual(identity.identity);
  expect(() => parseCliContext(identity.identity)).toThrow();
});

test('every v1 codec accepts and preserves the shared bootstrap failures', () => {
  for (const name of Object.keys(RPC_V1) as (keyof typeof RPC_V1)[]) {
    const wire = rpcWireV1(name);
    for (const failure of bootstrap) {
      expect(encodeFailure(wire.failure(failure as Failure)), name).toEqual(failure);
    }
  }
});

interface RuntimeFixture {
  readonly failures?: readonly Failure[];
  readonly responses?: readonly unknown[];
  readonly messages?: readonly unknown[];
}

const failures: Failure[] = [...bootstrap as Failure[]];
const directory = new URL('./fixtures/runtime/', import.meta.url);
for (const file of new Bun.Glob('*.json').scanSync(directory.pathname)) {
  const fixture: RuntimeFixture = await Bun.file(new URL(file, directory)).json();
  failures.push(...fixture.failures ?? []);
  if (fixture.responses) test(`${file} preserves HTTP status and retry envelopes`, () => {
    for (const reply of fixture.responses!) expect(parseCliHttpResponse(reply)).toEqual(reply);
    for (const reply of [{ status: 302, body: {} }, { status: 200 }, { status: 503, body: {}, retryAfter: 'soon' }]) {
      expect(() => parseCliHttpResponse(reply)).toThrow();
    }
  });
  if (fixture.messages) test(`${file} preserves terminal notification bytes`, () => {
    for (const frame of fixture.messages!) expect(parseTerminalStreamServerMessage(frame)).toEqual(frame);
  });
}

for (const failure of failures) {
  test(`${failure.domain ?? 'provider'} ${failure.code} preserves encoded failure and delivery semantics`, async () => {
    const requestTransport = new TestSessionTransport('synthetic-session', 'synthetic-worker', () => {});
    const replyTransport = new WorkerSessionTransport('synthetic-session', 'synthetic-controller', () => {});
    const replies: unknown[] = [];
    const requestSocket = requestTransport.attach({ send: frame => replySocket.receive(frame), close() {} });
    const replySocket = replyTransport.attach({ send: frame => { replies.push(JSON.parse(frame)); requestSocket.receive(frame); }, close() {} });
    const caller = new ExecutorRpc(requestTransport);
    const callee = new ExecutorRpc(replyTransport);
    handleTestRpc(callee, async () => { throw decodeFailure(failure); });
    try {
      await expect(caller.call('synthetic', RPC_V1['execution.runningSessions'], null)).rejects.toMatchObject({
        code: failure.code, message: failure.message,
        ...(failure.outcome ? { outcome: failure.outcome } : {}),
        ...(failure.status ? { status: failure.status } : {}),
      });
      expect(replies[0]).toEqual({ type: 'error', id: expect.any(String), error: failure });
      expect(requestTransport.connected).toBe(true);
    } finally { requestTransport.close(); replyTransport.close(); }
  });
}
