import { describe, expect, test } from 'bun:test';
import { AgentCommandReplies } from '../agent-command-replies.js';
import { parseGarconCommandRejection } from '../../../common/garcon-command-rejection.js';
import { KeyedPromiseLock } from '../../lib/keyed-lock.js';

const source = { chatId: '1000000000000001', viewId: '11111111-1111-4111-8111-111111111111', noticeOrdinal: 2 };
const issues = [{ command: 'ticket-create', reason: 'malformed', edge: 'leading' }];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(deliver = async () => 'delivered') {
  const controls = { enabled: true, exists: true, viewId: source.viewId };
  const inputs = [];
  const notices = [];
  const lock = new KeyedPromiseLock();
  const replies = new AgentCommandReplies({
    isEnabled: () => controls.enabled,
    registry: { getChat: () => controls.exists ? {} : null },
    notices: { existingCurrentView: () => ({ viewId: controls.viewId }), appendNotice: (...args) => notices.push(args) },
    chatMutationLock: lock,
    execution: { async deliverServerControlInput(chatId, input, signal) {
      await lock.runExclusive(`chat:${chatId}`, async () => {});
      inputs.push({ chatId, input, signal });
      return deliver(signal);
    } },
  });
  return { controls, inputs, notices, replies };
}

describe('agent command parse rejection replies', () => {
  test('delivers one grouped view-qualified control input without a user row, receipt, or extra notice', async () => {
    const f = fixture();
    f.replies.reject(source, issues);
    await tick();
    expect(f.inputs).toHaveLength(1);
    const { chatId, input } = f.inputs[0];
    expect(chatId).toBe(source.chatId);
    expect(input).toMatchObject({ transcriptViewId: source.viewId, receipt: null });
    expect(parseGarconCommandRejection(input.content).issues).toEqual(issues);
    expect(f.notices).toEqual([]);
    // A later malformed repair is a new candidate, not a replay of the first attempt.
    f.replies.reject({ ...source, noticeOrdinal: 4 }, issues);
    await tick();
    expect(f.inputs).toHaveLength(2);
    f.replies.shutdown();
  });

  test.each(['disabled', 'deleted', 'view', 'discard', 'shutdown'])('does not deliver after %s', async (fence) => {
    const f = fixture();
    f.replies.reject(source, issues);
    if (fence === 'disabled') f.controls.enabled = false;
    if (fence === 'deleted') f.controls.exists = false;
    if (fence === 'view') f.controls.viewId = '22222222-2222-4222-8222-222222222222';
    if (fence === 'discard') f.replies.discardSource(source.chatId);
    if (fence === 'shutdown') f.replies.shutdown();
    await tick();
    expect(f.inputs).toEqual([]);
    expect(f.notices).toEqual([]);
    f.replies.shutdown();
  });

  test.each(['discard', 'shutdown'])('aborts a held delivery on %s without retrying', async (fence) => {
    const pending = Promise.withResolvers();
    const f = fixture(() => pending.promise);
    f.replies.reject(source, issues);
    await tick();
    expect(f.inputs).toHaveLength(1);
    if (fence === 'discard') f.replies.discardSource(source.chatId);
    else f.replies.shutdown();
    expect(f.inputs[0].signal.aborted).toBe(true);
    pending.reject(new Error('Synthetic cancelled delivery'));
    await tick();
    expect(f.inputs).toHaveLength(1);
    expect(f.notices).toEqual([]);
    f.replies.shutdown();
  });

  test('a delivery failure does not retry or append a second diagnostic', async () => {
    const f = fixture(async () => { throw new Error('Synthetic delivery failure'); });
    f.replies.reject(source, issues);
    await tick();
    expect(f.inputs).toHaveLength(1);
    expect(f.notices).toEqual([]);
    f.replies.shutdown();
    f.replies.reject(source, issues);
    await tick();
    expect(f.inputs).toHaveLength(1);
  });
});
