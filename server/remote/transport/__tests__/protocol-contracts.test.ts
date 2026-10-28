import { WorkerSessionTransport, handleTestRpc } from '../../__tests__/test-session-transport.js';
import { RPC_V1, type RpcContractDefinition } from '@garcon/common/executor-contracts';
import { expect, test, spyOn } from 'bun:test';
import released from './fixtures/released-contracts.json';
import { createRoleContracts, registerRpcHandlers } from '../rpc-registrations.js';
import { rpcWireV1 } from '../rpc-wire-v1.js';
import { ExecutorRpc } from '../rpc.js';
import { RpcReplyJournal } from '../rpc-journal.js';
import { TestSessionTransport, testRoleContracts, testSessionProtocol } from '../../__tests__/test-session-transport.js';

const empty = { clients: [], handlers: [], resources: [], cli: [] } as const;

test('both production roles implement every released pair on their required sides', () => {
  for (const role of ['controller', 'worker'] as const) {
    const registry = testRoleContracts(role);
    expect(Object.entries(registry.offer.contracts).flatMap(([name, versions]) => versions.map(version => `${name}@${version}`)).sort()).toEqual(released);
    for (const definition of Object.values(RPC_V1) as RpcContractDefinition[]) {
      const sends = definition.direction === 'both' || definition.direction.startsWith(`${role}-to-`);
      const receives = definition.direction === 'both' || !sends;
      expect(registry.client(definition) !== null, `${role} sends ${definition.name}`).toBe(sends);
      expect(registry.receiver(definition) !== null, `${role} receives ${definition.name}`).toBe(receives);
    }
  }
});

test('offers follow executable role registrations, not declaration names', () => {
  const registry = createRoleContracts('controller', { ...empty, clients: [rpcWireV1('executor.describe')] });
  expect(registry.offer.contracts).toEqual({ 'executor.describe': [1] });
  expect(registry.client(RPC_V1['files.list'])).toBeNull();
  expect(Object.isFrozen(registry.offer.contracts['executor.describe'])).toBe(true);
});

test('registration rejects wrong directions, duplicates and one-sided bidirectional implementations', () => {
  const wire = rpcWireV1('executor.describe');
  expect(() => createRoleContracts('worker', { ...empty, clients: [wire] })).toThrow('Wrong contract direction');
  expect(() => createRoleContracts('controller', { ...empty, clients: [wire, wire] })).toThrow('Duplicate client');
  const handler = registerRpcHandlers([wire], async () => null);
  expect(() => createRoleContracts('worker', { ...empty, handlers: [handler, handler] })).toThrow('Duplicate handler');
  expect(() => createRoleContracts('controller', { ...empty, clients: [rpcWireV1('calls.reconcile')] })).toThrow('both role implementations');
});

test('registrations cannot omit prerequisites or a guaranteed creator event', () => {
  expect(() => createRoleContracts('controller', { ...empty, clients: [rpcWireV1('lifecycle.start')] })).toThrow('Incomplete flat requirements');
  const binding = rpcWireV1('producers.bind');
  const { rows: _rows, ...codecs } = binding.producer!.codecs;
  expect(() => createRoleContracts('controller', { ...empty, clients: [{ ...binding,
    producer: { ...binding.producer!, codecs } }] })).toThrow('Incomplete creator codecs');
  const attachment = rpcWireV1('terminals.attach');
  const { 'terminal-output': _output, ...terminalCodecs } = attachment.terminal!.codecs;
  expect(() => createRoleContracts('controller', { ...empty, clients: [{ ...attachment,
    terminal: { ...attachment.terminal!, codecs: terminalCodecs } }] })).toThrow('Incomplete creator codecs');
});

test('unsupported outgoing methods consume neither admission nor a sequence', async () => {
  const frames: { type: string; id: string; seq: number }[] = [];
  const protocol = testSessionProtocol();
  const { 'files.list': _unsupported, ...contracts } = protocol.profile.contracts;
  const transport = new TestSessionTransport('synthetic-session', 'synthetic-worker', () => {}, {}, 'local', 'primary', 'synthetic-session',
    { ...protocol, profile: { ...protocol.profile, contracts } });
  const socket = transport.attach({ send: payload => { frames.push(JSON.parse(payload)); }, close() {} });
  const rpc = new ExecutorRpc(transport);
  try {
    await expect(rpc.call('test', RPC_V1['files.list'], { projectPath: '/synthetic' })).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED', outcome: 'not-dispatched' });
    expect(frames).toEqual([]);
    const pending = rpc.call('test', RPC_V1['execution.runningSessions'], null);
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
  const transport = new WorkerSessionTransport('synthetic-session', 'synthetic-controller', () => {});
  const socket = transport.attach({ send: payload => { frames.push(JSON.parse(payload)); }, close() {} });
  const rpc = new ExecutorRpc(transport, { journal });
  let invoked = false;
  handleTestRpc(rpc, async () => { invoked = true; });
  try {
    socket.receive(JSON.stringify({ version: 1, type: 'request', id: 'synthetic-call', seq: 1, integrationId: 'test', method: 'synthetic.unsupported', request: null }));
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
