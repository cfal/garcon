import { describe, expect, it, mock, spyOn } from 'bun:test';
import { AgentStopController } from '../agent-stop-controller.ts';
import { KeyedPromiseLock } from '../../lib/keyed-lock.ts';

const SOURCE = '1000000000000000';
const TARGET = '2000000000000000';
const source = { chatId: SOURCE, viewId: 'view-source', runId: 'run-source', requestOrdinal: 3, at: '2030-01-01T00:00:00.000Z' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const chats = new Map([[SOURCE, {}], [TARGET, { parentChat: { chatId: SOURCE, relation: 'delegation' } }]]);
  const options = {
    registry: { getChat: (id) => chats.get(id) ?? null },
    notices: { existingCurrentView: mock(() => ({ viewId: source.viewId })), appendNotice: mock() },
    execution: { deliverServerControlInput: mock() },
    commands: { submitAgentCommandStopLocked: mock(async () => {}) },
    chatMutationLock: new KeyedPromiseLock(), isEnabled: mock(() => true),
  };
  const controller = new AgentStopController(options);
  return { chats, options, controller, request: (remove = false) => controller.request(source, { type: 'stop-agent', chatId: TARGET, remove }) };
}

describe('delegated stop controller', () => {
  it.each([false, true])('stops with remove=%s under both locks without a reply', async (remove) => {
    const f = fixture();
    const locks = spyOn(f.options.chatMutationLock, 'runExclusiveMany');
    f.request(remove);
    await tick();
    expect(locks.mock.calls[0][0]).toEqual([`chat:${SOURCE}`, `chat:${TARGET}`]);
    expect(f.options.commands.submitAgentCommandStopLocked).toHaveBeenCalledWith({
      sourceChatId: SOURCE, sourceViewId: source.viewId, chatId: TARGET, remove,
    }, expect.any(AbortSignal));
    expect(f.options.notices.appendNotice).not.toHaveBeenCalled();
    expect(f.options.execution.deliverServerControlInput).not.toHaveBeenCalled();
    f.controller.shutdown();
  });

  it.each([
    null, {}, { parentChat: { chatId: TARGET, relation: 'delegation' } },
    { parentChat: { chatId: SOURCE, relation: 'fork' } }, { parentChat: { chatId: SOURCE, relation: 'handoff' } },
  ])('rejects an unauthorized target before acquiring a foreign lock: %j', async (target) => {
    const f = fixture();
    if (target) f.chats.set(TARGET, target); else f.chats.delete(TARGET);
    const locks = spyOn(f.options.chatMutationLock, 'runExclusiveMany');
    f.request(true);
    await tick();
    expect(locks.mock.calls[0][0]).toEqual([`chat:${SOURCE}`]);
    expect(f.options.commands.submitAgentCommandStopLocked).not.toHaveBeenCalled();
    f.controller.shutdown();
  });

  it.each(['relationship', 'source', 'view', 'disabled', 'discard', 'shutdown'])('revalidates after waiting for locks: %s', async (change) => {
    const f = fixture();
    let release;
    const held = f.options.chatMutationLock.runExclusive(`chat:${TARGET}`, () => new Promise((resolve) => { release = resolve; }));
    await tick();
    f.request(true);
    await tick();
    expect(f.options.commands.submitAgentCommandStopLocked).not.toHaveBeenCalled();
    if (change === 'relationship') f.chats.set(TARGET, {});
    if (change === 'source') f.chats.delete(SOURCE);
    if (change === 'view') f.options.notices.existingCurrentView.mockReturnValue({ viewId: 'replacement' });
    if (change === 'disabled') f.options.isEnabled.mockReturnValue(false);
    if (change === 'discard') f.controller.discardSource(SOURCE);
    if (change === 'shutdown') f.controller.shutdown();
    release();
    await held;
    await tick();
    expect(f.options.commands.submitAgentCommandStopLocked).not.toHaveBeenCalled();
    f.controller.shutdown();
  });

  it('rejects self delegation and continues admitted deletion despite source cancellation', async () => {
    const f = fixture();
    f.chats.set(SOURCE, { parentChat: { chatId: SOURCE, relation: 'delegation' } });
    f.controller.request(source, { type: 'stop-agent', chatId: SOURCE, remove: true });
    await tick();
    expect(f.options.commands.submitAgentCommandStopLocked).not.toHaveBeenCalled();
    let finish;
    let completed = false;
    f.options.commands.submitAgentCommandStopLocked.mockImplementation(async () => {
      await new Promise((resolve) => { finish = resolve; });
      completed = true;
    });
    f.request(true);
    await tick();
    f.controller.discardSource(SOURCE);
    finish();
    await tick();
    expect(completed).toBe(true);
    expect(f.options.notices.appendNotice).not.toHaveBeenCalled();
    f.controller.shutdown();
  });
});
