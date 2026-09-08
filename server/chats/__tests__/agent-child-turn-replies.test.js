import { describe, expect, it, mock, spyOn } from 'bun:test';
import { AgentStartController } from '../agent-start-controller.ts';
import { AgentResumeController } from '../agent-resume-controller.ts';
import { CommandLedger } from '../../commands/command-ledger.ts';
import { KeyedPromiseLock } from '../../lib/keyed-lock.ts';
import { DomainError } from '../../lib/domain-error.ts';
import { parseGarconCommandResult } from '../../../common/garcon-command-results.ts';

const PARENT = '9000000000000000';
const CHILD = '1000000000000000';
const VIEW = '00000000-0000-4000-8000-000000000001';
const SOURCE = { chatId: PARENT, viewId: VIEW, requestOrdinal: 3, runId: 'parent-turn', at: '2030-01-01T00:00:00.000Z' };
const START = { type: 'start-agent', ref: 'task', async: false, fork: false, title: null,
  agentId: 'test', model: 'test', providerId: null, reasoningEffort: null, prompt: 'Synthetic task.' };
const RESUME = { type: 'resume-agent', ref: 'task', async: false, chatId: CHILD, prompt: 'Synthetic follow-up.' };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await Promise.resolve(); }
  throw new Error('Expected microtask progress');
}

function fixture(mode) {
  const turns = new CommandLedger(undefined, { recordLimit: 1 });
  const chats = new Map([[PARENT, { permissionMode: 'default', projectPath: '/synthetic' }],
    [CHILD, { parentChat: { chatId: PARENT, relation: 'delegation' } }]]);
  const notices = [];
  const deliveries = [];
  const admissions = [];
  let viewId = VIEW;
  let enabled = true;
  const context = {
    registry: { getChat: (id) => chats.get(id) ?? null },
    notices: { existingCurrentView: () => ({ viewId }), appendNotice: mock((_id, _view, notice) => notices.push(notice)) },
    execution: { deliverServerControlInput: mock(async (_id, input) => { deliveries.push(parseGarconCommandResult(input.content)); return 'queued'; }) },
    chatMutationLock: new KeyedPromiseLock(), turns, isEnabled: () => enabled,
  };
  const admit = mock(async (input) => {
    const turnId = `child-turn-${admissions.length + 1}`;
    const { record } = await turns.accept({ commandType: 'agent-run', chatId: CHILD,
      clientRequestId: input.clientRequestId, turnId, payload: { command: input.command } });
    admissions.push(record);
    return { success: true, status: 'scheduled', turnId, chat: { id: CHILD } };
  });
  const controller = mode === 'start'
    ? new AgentStartController({ ...context, chatIds: { allocate: () => CHILD },
      settings: { getExecutionDefaults: () => ({}) },
      selection: { catalog: async () => ({}), resolve: () => ({ permissionMode: 'default' }) },
      commands: { submitAgentCommandStartLocked: admit } })
    : new AgentResumeController({ ...context, commands: { submitAgentCommandResumeLocked: admit } });
  const command = mode === 'start' ? START : RESUME;
  const wait = spyOn(turns, 'waitForTurnTerminal');
  const finish = async (messages = ['First answer.', '  ', 'Second answer.'], status = 'finished', fields = {}) => {
    const record = admissions.at(-1);
    await turns.appendAssistantMessages(CHILD, record.turnId, messages);
    await turns.settleTerminal(record.key, status, fields);
    await turns.markPublicTerminal(CHILD, record.turnId);
  };
  return { controller, command, turns, wait, admit, finish, admissions, chats, context, notices, deliveries,
    disable: () => { enabled = false; }, replace: () => { viewId = '00000000-0000-4000-8000-000000000002'; } };
}

for (const mode of ['start', 'resume']) describe(`${mode} terminal reporting`, () => {
  it('acknowledges before reporting only the exact turn and releases both locks before waiting', async () => {
    const f = fixture(mode);
    f.controller.request(SOURCE, f.command);
    await until(() => f.deliveries.length === 1);
    expect(f.deliveries[0]).toMatchObject({ status: 'accepted', ref: 'task', async: false, chatId: CHILD });
    await f.context.chatMutationLock.runExclusiveMany([`chat:${PARENT}`, `chat:${CHILD}`], async () => undefined);
    expect(f.wait).toHaveBeenCalledWith(CHILD, f.admissions[0].turnId, expect.any(AbortSignal));
    f.disable();
    await f.finish();
    await until(() => f.deliveries.length === 2);
    expect(f.deliveries[1]).toMatchObject({ status: 'completed', output: {
      availability: 'available', completeness: 'complete', text: 'First answer.\n\nSecond answer.',
    } });
    expect(f.notices.map((notice) => notice.detail.status)).toEqual(['accepted', 'completed']);
    expect(f.notices[1].content).toContain('First answer.\n\nSecond answer.');
  });

  it('async requests register no waiter and repeated refs do not deduplicate admission', async () => {
    const f = fixture(mode);
    f.controller.request(SOURCE, { ...f.command, async: true });
    await until(() => f.deliveries.length === 1);
    await f.finish();
    f.controller.request({ ...SOURCE, requestOrdinal: 5 }, { ...f.command, async: true });
    await until(() => f.deliveries.length === 2);
    expect(f.wait).not.toHaveBeenCalled();
    expect(f.admit).toHaveBeenCalledTimes(2);
    expect(f.admit.mock.calls[0][0].clientRequestId).not.toBe(f.admit.mock.calls[1][0].clientRequestId);
    expect(f.notices.map((notice) => notice.detail.status)).toEqual(['accepted', 'accepted']);
  });

  it('captures a fast child and survives held failed acknowledgment plus receipt removal', async () => {
    const f = fixture(mode);
    const ack = deferred();
    const delivering = deferred();
    f.context.execution.deliverServerControlInput.mockImplementationOnce(async (_id, input) => {
      f.deliveries.push(parseGarconCommandResult(input.content)); delivering.resolve(); await ack.promise;
      throw new Error('Synthetic acknowledgment failure');
    });
    const originalAdmit = f.admit.getMockImplementation();
    f.admit.mockImplementation(async (input) => {
      const accepted = await originalAdmit(input);
      await f.finish(['Captured before admission returns.']);
      return accepted;
    });
    f.controller.request(SOURCE, f.command);
    await delivering.promise;
    const other = (await f.turns.accept({ chatId: CHILD, turnId: 'later-turn', commandType: 'agent-run',
      clientRequestId: 'later', payload: {} })).record;
    await f.turns.settleTerminal(other.key, 'finished');
    await f.turns.markPublicTerminal(CHILD, other.turnId);
    expect(await f.turns.getTurnRecord(CHILD, f.admissions[0].turnId)).toBeNull();
    expect(f.notices).toHaveLength(1);
    ack.resolve();
    await until(() => f.notices.length === 2 && f.deliveries.length === 2);
    expect(f.deliveries[1].output.text).toBe('Captured before admission returns.');
    expect(f.wait).toHaveBeenCalledTimes(1);
  });

  it('failed admission notice does not suppress the independent completion', async () => {
    const f = fixture(mode);
    f.context.notices.appendNotice.mockImplementationOnce(() => { throw new Error('Synthetic notice failure'); });
    f.controller.request(SOURCE, f.command);
    await until(() => f.wait.mock.calls.length === 1);
    await f.finish(['Recovered completion.']);
    await until(() => f.deliveries.length === 1);
    expect(f.deliveries[0].status).toBe('completed');
    expect(f.admit).toHaveBeenCalledTimes(1);
  });

  it.each(['discard', 'shutdown', 'replace', 'delete'])('cancels reporting, never child work: %s', async (action) => {
    const f = fixture(mode);
    f.controller.request(SOURCE, f.command);
    await until(() => f.deliveries.length === 1);
    const signal = f.wait.mock.calls[0][2];
    if (action === 'replace') f.replace();
    if (action === 'delete') f.chats.delete(PARENT);
    if (action === 'shutdown') f.controller.shutdown();
    else f.controller.discardSource(PARENT);
    expect(signal.aborted).toBe(true);
    await f.finish();
    await f.context.chatMutationLock.runExclusiveMany([`chat:${PARENT}`, `chat:${CHILD}`], async () => undefined);
    expect(f.notices).toHaveLength(1);
    expect(f.chats.has(CHILD)).toBe(true);
    if (action === 'shutdown') {
      f.controller.request(SOURCE, f.command);
      await f.context.chatMutationLock.runExclusive(`chat:${PARENT}`, async () => undefined);
      expect(f.admit).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ['failed', { errorCode: 'INTERNAL_ERROR' }, 'failed'],
    ['finished', { interruptionReason: 'user-stop' }, 'interrupted'],
    ['finished', { interruptionReason: 'chat-deleted' }, 'interrupted'],
  ])('reports public %s receipt with partial output', async (status, fields, expected) => {
    const f = fixture(mode);
    f.controller.request(SOURCE, f.command);
    await until(() => f.deliveries.length === 1);
    await f.finish(['Partial answer.'], status, fields);
    await until(() => f.deliveries.length === 2);
    expect(f.deliveries[1]).toMatchObject({ status: expected, output: { completeness: 'best-effort', text: 'Partial answer.' } });
  });
});

describe('resume authority', () => {
  it.each([null, { chatId: PARENT, relation: 'fork' }, { chatId: PARENT, relation: 'handoff' },
    { chatId: '2000000000000000', relation: 'delegation' }])('rejects a nondelegated edge without taking a foreign lock: %j', async (parentChat) => {
    const f = fixture('resume');
    f.chats.set(CHILD, { parentChat });
    const lock = spyOn(f.context.chatMutationLock, 'runExclusiveMany');
    f.controller.request(SOURCE, f.command);
    await until(() => f.deliveries.length === 1);
    expect(lock.mock.calls[0][0]).toEqual([`chat:${PARENT}`]);
    expect(f.deliveries[0]).toMatchObject({ status: 'rejected', reason: 'not-delegated' });
    expect(f.deliveries[0]).not.toHaveProperty('chatId');
    expect(f.admit).not.toHaveBeenCalled();
  });

  it.each([
    ['SESSION_BUSY', 'rejected', 'busy'], ['PREAMBLE_SLASH_COMMAND_BLOCKED', 'preamble-rejected', 'slash-command-blocked'],
    ['PREAMBLE_SELECTION_COMPOSITION_INVALID', 'preamble-rejected', 'composition-invalid'],
  ])('preserves the authorized child after %s', async (code, status, reason) => {
    const f = fixture('resume');
    f.admit.mockRejectedValue(new DomainError(code, 'Synthetic rejection'));
    f.controller.request(SOURCE, f.command);
    await until(() => f.deliveries.length === 1);
    expect(f.deliveries[0]).toMatchObject({ status, reason, chatId: CHILD });
    expect(f.wait).not.toHaveBeenCalled();
    expect(f.chats.has(CHILD)).toBe(true);
  });
});
