import { expect, test, spyOn } from 'bun:test';
import core from './fixtures/core-1-names.json';
import { CLI_REQUIREMENTS, RPC_REQUIREMENTS } from '../protocol-policy.js';
import { MESSAGE_REQUIREMENTS, PRODUCER_REQUIREMENTS } from '../producer-protocol.js';
import { CLI_OPERATIONS } from '../cli-protocol.js';
import { ExecutorRpc } from '../rpc.js';
import { RpcReplyJournal } from '../rpc-journal.js';
import type { ExecutorRpcMethods } from '../rpc-protocol.js';
import type { ProtocolRequirement } from '../protocol-compatibility.js';
import { TestSessionTransport } from '../../__tests__/test-session-transport.js';

function coreNames(requirements: Readonly<Record<string, ProtocolRequirement>>): string[] {
  return Object.keys(requirements).filter(key => requirements[key]!.kind === 'core').sort();
}

test('the frozen core contains exactly its explicitly classified vocabulary', () => {
  expect(coreNames(RPC_REQUIREMENTS)).toEqual(core.rpc);
  expect(coreNames(CLI_REQUIREMENTS)).toEqual(core.cli);
  expect(coreNames(PRODUCER_REQUIREMENTS)).toEqual(core.producer);
  expect(coreNames(MESSAGE_REQUIREMENTS)).toEqual(core.messages);
  expect(Object.keys(CLI_REQUIREMENTS).sort()).toEqual(Object.keys(CLI_OPERATIONS).sort());
  expect(coreNames({ ...CLI_REQUIREMENTS, 'GET /synthetic-optional': { kind: 'contract', name: 'synthetic.workflow', version: 1 } })).toEqual(core.cli);
});

test('unsupported outgoing methods consume neither admission nor a sequence', async () => {
  const frames: { type: string; id: string; seq: number }[] = [];
  const transport = new TestSessionTransport('synthetic-session', 'synthetic-worker', () => {});
  const socket = transport.attach({ send: payload => { frames.push(JSON.parse(payload)); }, close() {} });
  const rpc = new ExecutorRpc(transport);
  try {
    await expect(rpc.call('test', 'synthetic.unsupported' as keyof ExecutorRpcMethods, null)).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED', outcome: 'not-dispatched' });
    expect(frames).toEqual([]);
    const pending = rpc.call('test', 'execution.runningSessions', null);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.seq).toBe(1);
    socket.receive(JSON.stringify({ type: 'result', id: frames[0]!.id, value: [] }));
    await expect(pending).resolves.toEqual([]);
  } finally { transport.close(); }
});

test('unknown incoming methods fail before handlers and journal receipt ownership', async () => {
  const frames: unknown[] = [];
  const journal = new RpcReplyJournal();
  const received = spyOn(journal, 'received');
  const begin = spyOn(journal, 'begin');
  const transport = new TestSessionTransport('synthetic-session', 'synthetic-controller', () => {});
  const socket = transport.attach({ send: payload => { frames.push(JSON.parse(payload)); }, close() {} });
  const rpc = new ExecutorRpc(transport, { journal });
  let invoked = false;
  rpc.handle(async () => { invoked = true; });
  try {
    socket.receive(JSON.stringify({ type: 'request', id: 'synthetic-call', seq: 1, integrationId: 'test', method: 'synthetic.unsupported', request: null }));
    await Promise.resolve();
    expect(frames).toEqual([{ type: 'error', id: 'synthetic-call', error: {
      code: 'OPERATION_UNSUPPORTED', message: 'Executor protocol does not support this operation', retryable: false, outcome: 'not-dispatched',
    } }]);
    expect(invoked).toBe(false);
    expect(received).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(transport.connected).toBe(true);
  } finally { transport.close(); journal.dispose(); received.mockRestore(); begin.mockRestore(); }
});
