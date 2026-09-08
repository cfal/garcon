import { describe, expect, it, spyOn } from 'bun:test';
import { CommandLedger, PRE_SCHEDULE_FAILURE_ERROR_CODE } from '../command-ledger.ts';

async function accept(ledger, turnId = 'turn-1') {
  return (await ledger.accept({
    commandType: 'agent-run', chatId: '1111111111111111',
    clientRequestId: turnId, turnId, payload: { command: 'Synthetic prompt.' },
  })).record;
}

const CHILD = '1111111111111111';

describe('CommandLedger terminal observation', () => {
  it('captures public output before eviction and serves fast completions', async () => {
    const ledger = new CommandLedger(undefined, { recordLimit: 1 });
    const record = await accept(ledger);
    const signal = new AbortController().signal;
    const remove = spyOn(signal, 'removeEventListener');
    let settled = false;
    const first = ledger.waitForTurnTerminal(CHILD, record.turnId, signal)
      .then((value) => { settled = true; return value; });
    const second = ledger.waitForTurnTerminal(CHILD, record.turnId, signal);
    await ledger.settleTerminal(record.key, 'finished');
    expect(settled).toBe(false);
    await ledger.appendAssistantMessages(CHILD, record.turnId, ['Synthetic answer.']);
    await ledger.markPublicTerminal(CHILD, record.turnId);
    const fast = await ledger.waitForTurnTerminal(CHILD, record.turnId, signal);
    expect(fast.assistantMessages).toEqual(['Synthetic answer.']);
    const other = await accept(ledger, 'turn-2');
    await ledger.settleTerminal(other.key, 'finished');
    await ledger.markPublicTerminal(CHILD, other.turnId);
    expect(await ledger.getTurnRecord(CHILD, record.turnId)).toBeNull();
    expect((await first).assistantMessages).toEqual(['Synthetic answer.']);
    const independent = await second;
    independent.assistantMessages.push('Mutated clone.');
    expect((await first).assistantMessages).toEqual(['Synthetic answer.']);
    expect(remove).toHaveBeenCalledTimes(2);
    remove.mockRestore();
  });

  it('aborts independently, cleans listeners and never waits on absent or private receipts', async () => {
    const ledger = new CommandLedger();
    const record = await accept(ledger);
    const abort = new AbortController();
    const remove = spyOn(abort.signal, 'removeEventListener');
    const cancelled = ledger.waitForTurnTerminal(CHILD, record.turnId, abort.signal);
    const rejected = cancelled.catch((error) => error);
    abort.abort(new Error('cancelled'));
    expect((await rejected).message).toBe('cancelled');
    expect(remove).toHaveBeenCalledTimes(1);
    await expect(ledger.waitForTurnTerminal(CHILD, record.turnId, abort.signal))
      .rejects.toThrow('cancelled');
    remove.mockRestore();
    const signal = new AbortController().signal;
    const pending = ledger.waitForTurnTerminal(CHILD, record.turnId, signal);
    await ledger.update(record.key, { status: 'failed', retainedPrivateTerminal: true });
    expect(await pending).toBeNull();
    expect(await ledger.waitForTurnTerminal(CHILD, record.turnId, signal)).toBeNull();
    expect(await new CommandLedger().waitForTurnTerminal(CHILD, record.turnId, signal)).toBeNull();
  });

  it('does not attach a pre-schedule retry waiter to the replacement turn', async () => {
    const ledger = new CommandLedger();
    const record = await accept(ledger);
    const signal = new AbortController().signal;
    const pending = ledger.waitForTurnTerminal(CHILD, record.turnId, signal);
    await ledger.update(record.key, { status: 'failed', errorCode: PRE_SCHEDULE_FAILURE_ERROR_CODE });
    await ledger.accept({ commandType: record.commandType, chatId: CHILD,
      clientRequestId: record.clientRequestId, turnId: 'replacement', payload: record.payload });
    expect(await pending).toBeNull();
    expect(await ledger.waitForTurnTerminal(CHILD, record.turnId, signal)).toBeNull();
  });

  it.each(['delete', 'cancel'])('defers public completion until deletion resolves: %s', async (mode) => {
    const ledger = new CommandLedger();
    const record = await accept(ledger);
    let settled = false;
    const pending = ledger.waitForTurnTerminal(CHILD, record.turnId, new AbortController().signal)
      .then((value) => { settled = true; return value; });
    ledger.beginChatDeletion(CHILD);
    await ledger.settleTerminal(record.key, 'finished');
    await ledger.markPublicTerminal(CHILD, record.turnId, 'chat-deleted');
    expect(settled).toBe(false);
    if (mode === 'delete') await ledger.markChatInterrupted(CHILD, 'chat-deleted');
    else await ledger.cancelChatDeletion(CHILD);
    expect((await pending).interruptionReason).toBe(mode === 'delete' ? 'chat-deleted' : 'user-stop');
  });

  it('uses only the immutable receipt owner, including steer tombstones', async () => {
    const ledger = new CommandLedger(undefined, { recordLimit: 0 });
    const record = await accept(ledger);
    const pending = ledger.waitForTurnTerminal(CHILD, record.turnId, new AbortController().signal);
    const steer = (await ledger.accept({ commandType: 'steer', chatId: CHILD,
      clientRequestId: 'steer', turnId: record.turnId, payload: {} })).record;
    await ledger.settleTerminal(steer.key, 'finished', { retainedPrivateTerminal: true });
    await ledger.appendAssistantMessages(CHILD, record.turnId, ['Original owner.']);
    await ledger.settleTerminal(record.key, 'finished');
    await ledger.markPublicTerminal(CHILD, record.turnId);
    expect((await pending).assistantMessages).toEqual(['Original owner.']);
    expect(await ledger.getTurnRecord(CHILD, record.turnId)).toBeNull();
  });

  it('captures output before later result retention pressure expires it', async () => {
    const ledger = new CommandLedger(undefined, { totalTurnResultByteLimit: 4 });
    const record = await accept(ledger);
    const signal = new AbortController().signal;
    const pending = ledger.waitForTurnTerminal(CHILD, record.turnId, signal);
    await ledger.appendAssistantMessages(CHILD, record.turnId, ['1234']);
    await ledger.settleTerminal(record.key, 'finished');
    await ledger.markPublicTerminal(CHILD, record.turnId);
    const other = await accept(ledger, 'turn-2');
    await ledger.appendAssistantMessages(CHILD, other.turnId, ['5678']);
    expect((await pending).assistantMessages).toEqual(['1234']);
    expect((await ledger.waitForTurnTerminal(CHILD, record.turnId, signal)).turnResultAvailability).toBe('expired');
  });
});
