import { expect, test, mock } from 'bun:test';
import { AgentIntegrationError, type AgentIntegrationErrorCode } from '@garcon/server-agent-interface';
import { RPC_V1 } from '@garcon/common/executor-contracts';
import { ExecutorRpc } from '../rpc.js';
import { RpcReplyJournal } from '../rpc-journal.js';
import type { RpcLane } from '../rpc-lane.js';
import { TestSessionTransport, WorkerSessionTransport, handleTestRpc } from '../../__tests__/test-session-transport.js';

function pair(lane: RpcLane = 'primary') {
  const journal = new RpcReplyJournal();
  const controller = new TestSessionTransport('synthetic-session', 'synthetic-worker', () => {}, {}, 'local', lane);
  const worker = new WorkerSessionTransport('synthetic-session', 'synthetic-controller', () => {}, {}, 'local', lane);
  const replies: string[] = [];
  const acks = Promise.withResolvers<readonly string[]>();
  let rewrite: ((frame: Record<string, unknown>) => object) | null = null;
  const left = controller.attach({ send(payload) {
    const frame = JSON.parse(payload);
    right.receive(payload);
    if (frame.type === 'reply-ack') acks.resolve(frame.ids);
  }, close() {} });
  const right = worker.attach({ send(payload) {
    replies.push(payload);
    left.receive(rewrite ? JSON.stringify(rewrite(JSON.parse(payload))) : payload);
  }, close() {} });
  const client = new ExecutorRpc(controller);
  const service = new ExecutorRpc(worker, { journal });
  return { client, service, controller, worker, replies, journal, acks: acks.promise,
    rewrite(fn: (frame: Record<string, unknown>) => object) { rewrite = fn; },
    close() { controller.close(); worker.close(); journal.dispose(); } };
}

const gitCases = [
  { contract: RPC_V1['git.getStatus'], input: { projectPath: '/project' }, code: 'GIT_INVALID_RESULT' },
  { contract: RPC_V1['git.stagePaths'], input: { projectPath: '/project', paths: ['file'], mode: 'stage' as const }, code: 'GIT_MUTATION_OUTCOME_UNKNOWN' },
] as const;

for (const { contract, input, code } of gitCases) {
  test(`${contract.name} contains invalid sender results and acknowledges invalid peer results`, async () => {
    const fixture = pair('bulk');
    handleTestRpc(fixture.service, async () => ({}));
    try {
      await expect(fixture.client.call('', contract, { input, budgetMs: 1000 })).rejects.toMatchObject({ code });
      expect(fixture.controller.connected && fixture.worker.connected).toBe(true);
      fixture.rewrite(frame => frame.type === 'error' ? { type: 'result', id: frame.id, value: {} } : frame);
      await expect(fixture.client.call('', contract, { input, budgetMs: 1000 })).rejects.toMatchObject({ code });
      expect(fixture.controller.connected && fixture.worker.connected).toBe(true);
      expect(await fixture.acks).toHaveLength(2);
      expect(fixture.journal.size).toBe(0);
    } finally { fixture.close(); }
  });
}

test('malformed Files confirmations remain uncertain, not definite validation failures', async () => {
  const fixture = pair('bulk');
  handleTestRpc(fixture.service, async () => ({}));
  try {
    await expect(fixture.client.call('', RPC_V1['files.createDirectory'], { parentPath: '/project', name: 'directory' }))
      .rejects.toMatchObject({ code: 'FILE_CREATE_OUTCOME_UNKNOWN', status: 503 });
    await expect(fixture.client.call('', RPC_V1['files.save'], { projectPath: '/project', filePath: 'file',
      data: '', expectedRevision: 'v1:synthetic-revision', conflictResolution: 'reject' }))
      .rejects.toMatchObject({ code: 'FILE_SAVE_OUTCOME_UNKNOWN', status: 503 });
    expect(fixture.controller.connected && fixture.worker.connected).toBe(true);
  } finally { fixture.close(); }
});

test.each(['handler', 'guard', 'serialization'] as const)('%s failures retain the journal fallback without closing the session', async source => {
  const fixture = pair();
  const undelivered = mock(() => {});
  handleTestRpc(fixture.service, async (_call, _signal, guard, observe) => {
    observe(undelivered);
    const error = new AgentIntegrationError('SYNTHETIC_FUTURE_CODE' as AgentIntegrationErrorCode, 'Synthetic failure', false);
    if (source === 'handler') throw error;
    if (source === 'guard') guard(() => { throw error; });
    const command: Record<string, unknown> = { name: 'synthetic', source: 'command' };
    if (source === 'serialization') command.cycle = command;
    return [command];
  });
  try {
    const pending = fixture.client.call('synthetic', RPC_V1['commands.discover'], { projectPath: '/project' });
    await expect(pending).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', outcome: 'unknown' });
    expect(undelivered).not.toHaveBeenCalled();
    const reply = fixture.replies.find(payload => JSON.parse(payload).type === 'error')!;
    expect(JSON.parse(reply).error).toMatchObject({ code: 'OUTCOME_UNKNOWN', outcome: 'unknown' });
    const captured: string[] = [];
    fixture.worker.close();
    fixture.journal.reconcile({ lane: 'primary', session: 'replacement', continuity: fixture.worker.continuity,
      offer(payload) { captured.push(payload); return true; } }, [{ id: JSON.parse(reply).id, session: fixture.worker.id, seq: 1 }]);
    fixture.journal.deliver();
    expect(captured).toEqual([reply]);
    expect(fixture.controller.connected).toBe(true);
  } finally { fixture.close(); }
});

test('an unreadable cancelled result releases its cleanup budget and reports lost cleanup', async () => {
  const transport = new TestSessionTransport('synthetic-session', 'synthetic-worker', () => {});
  const sent: { type: string; id: string }[] = [];
  const socket = transport.attach({ send: frame => sent.push(JSON.parse(frame)), close() {} });
  const rpc = new ExecutorRpc(transport);
  const receive = mock(() => {});
  const lost = mock(() => {});
  const abort = new AbortController();
  try {
    const pending = rpc.call('synthetic', RPC_V1['execution.runningSessions'], null, {
      signal: abort.signal, onLateResult: receive, onLateResultLost: lost,
    });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    socket.receive(JSON.stringify({ type: 'result', id: sent[0]!.id, value: ['invalid'] }));
    await Promise.resolve();
    expect(receive).not.toHaveBeenCalled();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(transport.connected).toBe(true);
  } finally { transport.close(); }
});
