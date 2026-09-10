import { describe, expect, it } from 'bun:test';
import {
  CommandLedger,
  GOAL_CONTROL_OUTCOME_UNKNOWN_ERROR_CODE,
  LEDGER_RECORD_LIMIT,
  PRE_SCHEDULE_FAILURE_ERROR_CODE,
  SteerIdentityCapacityError,
  commandLedgerKey,
  commandPayloadHash,
} from '../command-ledger.ts';
import { ChatCommandSettlement } from '../chat-command-settlement.ts';
import { DomainError } from '../../lib/domain-error.ts';

function acceptedInput(overrides = {}) {
  return {
    commandType: 'agent-run',
    chatId: 'chat-1',
    clientRequestId: 'request-1',
    payload: { chatId: 'chat-1', command: 'hello' },
    ...overrides,
  };
}

describe('CommandLedger', () => {
  it('accepts, deduplicates, and rejects conflicting request identities', async () => {
    const ledger = new CommandLedger();
    const accepted = await ledger.accept(acceptedInput());
    const duplicate = await ledger.accept(acceptedInput());
    const payloadConflict = await ledger.accept(acceptedInput({ payload: { command: 'different' } }));
    const commandConflict = await ledger.accept(acceptedInput({ commandType: 'agent-stop' }));

    expect(accepted.kind).toBe('accepted');
    expect(duplicate.kind).toBe('duplicate');
    expect(payloadConflict.kind).toBe('conflict');
    expect(commandConflict.kind).toBe('conflict');
  });

  it('reopens failures that happened before scheduling', async () => {
    const ledger = new CommandLedger();
    const accepted = await ledger.accept(acceptedInput());
    await ledger.update(accepted.record.key, {
      status: 'failed',
      error: 'append failed',
      errorCode: PRE_SCHEDULE_FAILURE_ERROR_CODE,
    });

    const retry = await ledger.accept(acceptedInput());

    expect(retry).toMatchObject({ kind: 'accepted', record: { status: 'accepted' } });
    expect(retry.record.error).toBeUndefined();
    expect(retry.record.errorCode).toBeUndefined();
  });

  it('settles terminal status idempotently and rejects a conflicting settlement', async () => {
    const ledger = new CommandLedger();
    const accepted = await ledger.accept(acceptedInput());

    expect(await ledger.settleTerminal(accepted.record.key, 'finished')).toMatchObject({
      kind: 'applied',
      record: { status: 'finished' },
    });
    expect(await ledger.settleTerminal(accepted.record.key, 'finished')).toMatchObject({
      kind: 'duplicate',
    });
    expect(await ledger.settleTerminal(accepted.record.key, 'failed')).toMatchObject({
      kind: 'conflict',
    });
  });

  it('updates only records outside blocked statuses', async () => {
    const ledger = new CommandLedger();
    const accepted = await ledger.accept(acceptedInput());
    await ledger.update(accepted.record.key, { status: 'running' });

    const blocked = await ledger.updateUnlessStatus(accepted.record.key, ['running'], {
      status: 'finished',
    });
    const updated = await ledger.updateUnlessStatus(accepted.record.key, ['accepted'], {
      status: 'finished',
    });

    expect(blocked?.status).toBe('running');
    expect(updated?.status).toBe('finished');
  });

  it('compacts attachment data before storing or hashing payloads', async () => {
    const ledger = new CommandLedger();
    const payload = {
      chatId: 'chat-1',
      images: [{ name: 'image.png', mimeType: 'image/png', data: 'base64-data' }],
    };
    const accepted = await ledger.accept(acceptedInput({ payload }));

    expect(accepted.record.payload).toEqual({
      chatId: 'chat-1',
      images: [{
        name: 'image.png',
        mimeType: 'image/png',
        dataSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        dataLength: 11,
      }],
    });
    expect(accepted.record.payloadHash).toBe(commandPayloadHash(payload));
  });

  it('reports unsettled queue receipt keys synchronously', async () => {
    const ledger = new CommandLedger();
    const first = await ledger.accept(acceptedInput({
      commandType: 'queue-entry-create',
      clientRequestId: 'queue-1',
    }));
    const second = await ledger.accept(acceptedInput({
      commandType: 'queue-entry-delete',
      clientRequestId: 'queue-2',
    }));
    const goalControl = await ledger.accept(acceptedInput({
      commandType: 'goal-control',
      clientRequestId: 'goal-control-1',
    }));
    await ledger.accept(acceptedInput({
      commandType: 'steer',
      clientRequestId: 'steer-1',
    }));
    await ledger.settleTerminal(first.record.key, 'finished');

    expect(ledger.unsettledQueueReceiptKeys('chat-1')).toEqual(new Set([
      second.record.key,
      goalControl.record.key,
    ]));
  });

  it('indexes turn results and exposes them only after the public terminal barrier', async () => {
    const ledger = new CommandLedger();
    const accepted = await ledger.accept(acceptedInput({ turnId: 'turn-1' }));

    await ledger.setTurnResult('chat-1', 'turn-1', { type: 'text', text: 'first\n\nsecond' });
    await ledger.settleTerminal(accepted.record.key, 'finished');
    const terminal = await ledger.getTurnRecord('chat-1', 'turn-1');
    expect(terminal).toMatchObject({
      status: 'finished',
      turnResult: { availability: 'available', text: 'first\n\nsecond' },
      payload: {},
    });
    expect(terminal.publicTerminalAt).toBeUndefined();

    await ledger.markPublicTerminal('chat-1', 'turn-1');
    expect(await ledger.getTurnRecord('chat-1', 'turn-1')).toMatchObject({
      publicTerminalAt: expect.any(String),
    });
  });

  it('keeps terminal turns private until chat deletion is committed', async () => {
    const ledger = new CommandLedger();
    const accepted = await ledger.accept(acceptedInput({ turnId: 'turn-1' }));
    ledger.beginChatDeletion('chat-1');

    await ledger.settleTerminal(accepted.record.key, 'finished');
    await ledger.markPublicTerminal('chat-1', 'turn-1');
    await ledger.markPublicTerminal('chat-1', 'turn-1', 'chat-deleted');

    expect(await ledger.getTurnRecord('chat-1', 'turn-1')).toMatchObject({
      status: 'finished',
      interruptionReason: 'chat-deleted',
    });
    expect((await ledger.getTurnRecord('chat-1', 'turn-1')).publicTerminalAt).toBeUndefined();

    await ledger.markChatInterrupted('chat-1', 'chat-deleted');
    expect(await ledger.getTurnRecord('chat-1', 'turn-1')).toMatchObject({
      status: 'finished',
      interruptionReason: 'chat-deleted',
      publicTerminalAt: expect.any(String),
    });
  });

  it('settles an interrupted reservation without touching another turn', async () => {
    const ledger = new CommandLedger();
    await ledger.accept(acceptedInput({ turnId: 'reserved-turn' }));
    await ledger.accept(acceptedInput({ turnId: 'other-turn', clientRequestId: 'other-request' }));
    const terminal = ledger.waitForTurnTerminal('chat-1', 'reserved-turn', new AbortController().signal);

    await ledger.markInterruptedWithoutRunTerminal('chat-1', 'reserved-turn', 'user-stop');

    expect(await terminal).toMatchObject({
      status: 'finished', interruptionReason: 'user-stop', publicTerminalAt: expect.any(String),
      turnResult: { availability: 'unavailable', reason: 'no-final-response' },
    });
    expect((await ledger.getTurnRecord('chat-1', 'other-turn')).publicTerminalAt).toBeUndefined();
  });

  it.each([null, { type: 'text', text: 'Synthetic final output' }])(
    'leaves a captured run result to its terminal pipeline: %j', async (response) => {
      const ledger = new CommandLedger();
      const accepted = await ledger.accept(acceptedInput({ turnId: 'turn-1' }));
      // Neither call yields before inspecting the captured terminal result.
      const capture = ledger.setTurnResult('chat-1', 'turn-1', response);
      const stop = ledger.markInterruptedWithoutRunTerminal('chat-1', 'turn-1', 'user-stop');
      const captured = await capture;
      expect(await stop).toEqual(captured);
      expect(captured.publicTerminalAt).toBeUndefined();
      expect(captured.interruptionReason).toBeUndefined();

      await ledger.settleTerminal(accepted.record.key, 'finished');
      const terminal = await ledger.markPublicTerminal('chat-1', 'turn-1');
      expect(terminal.turnResult).toEqual(captured.turnResult);
      expect(terminal.interruptionReason).toBeUndefined();
      expect(terminal.publicTerminalAt).toEqual(expect.any(String));
    },
  );

  it('distinguishes failure settlement from an observed run terminal', async () => {
    const ledger = new CommandLedger();
    const accepted = await ledger.accept(acceptedInput({ turnId: 'turn-1' }));
    const failed = await ledger.settleTerminal(accepted.record.key, 'failed');
    expect(failed.record.turnResult).toEqual({ availability: 'unavailable', reason: 'no-final-response' });
    expect(failed.record.runTerminalObserved).toBeUndefined();

    expect(await ledger.markInterruptedWithoutRunTerminal('chat-1', 'turn-1', 'user-stop')).toMatchObject({
      interruptionReason: 'user-stop', publicTerminalAt: expect.any(String),
    });
  });

  it('captures a run terminal after failure settlement without publishing it early', async () => {
    const ledger = new CommandLedger();
    const accepted = await ledger.accept(acceptedInput({ turnId: 'turn-1' }));
    await ledger.settleTerminal(accepted.record.key, 'failed');
    await ledger.setTurnResult('chat-1', 'turn-1', null);

    const stopped = await ledger.markInterruptedWithoutRunTerminal('chat-1', 'turn-1', 'user-stop');
    expect(stopped.runTerminalObserved).toBe(true);
    expect(stopped.publicTerminalAt).toBeUndefined();
    expect(stopped.interruptionReason).toBeUndefined();
    expect(await ledger.markPublicTerminal('chat-1', 'turn-1')).toMatchObject({
      status: 'failed', publicTerminalAt: expect.any(String),
    });
  });

  it('publishes an acknowledged stop as user-stop when deletion is rolled back', async () => {
    const ledger = new CommandLedger();
    await ledger.accept(acceptedInput({ turnId: 'turn-1' }));
    ledger.beginChatDeletion('chat-1');
    await ledger.markPublicTerminal('chat-1', 'turn-1', 'chat-deleted');

    await ledger.cancelChatDeletion('chat-1');

    expect(await ledger.getTurnRecord('chat-1', 'turn-1')).toMatchObject({
      status: 'finished',
      interruptionReason: 'user-stop',
      publicTerminalAt: expect.any(String),
    });
  });

  it('discards an oversized result instead of retaining a truncated prefix', async () => {
    const ledger = new CommandLedger(undefined, { turnResultByteLimit: 5 });
    await ledger.accept(acceptedInput({ turnId: 'turn-large' }));

    await ledger.setTurnResult('chat-1', 'turn-large', { type: 'text', text: '123456' });

    expect(await ledger.getTurnRecord('chat-1', 'turn-large')).toMatchObject({
      turnResult: { availability: 'unavailable', reason: 'too-large' },
    });
    expect((await ledger.getTurnRecord('chat-1', 'turn-large')).turnResult.text).toBeUndefined();
  });

  it.each([null, { type: 'text', text: '' }, { type: 'text', text: 'Final answer.' }])(
    'captures exactly once, distinguishing absent and empty finals: %j', async (response) => {
      const ledger = new CommandLedger();
      await ledger.accept(acceptedInput({ turnId: 'turn-one' }));
      await ledger.setTurnResult('chat-1', 'turn-one', response);
      await ledger.setTurnResult('chat-1', 'turn-one', { type: 'text', text: 'Late replacement.' });
      expect((await ledger.getTurnRecord('chat-1', 'turn-one')).turnResult).toEqual(response === null
        ? { availability: 'unavailable', reason: 'no-final-response' }
        : { availability: 'available', text: response.text, bytes: Buffer.byteLength(response.text) });
    },
  );

  it.each(['failed', 'rejected', 'interrupted'])('discards retained final text after %s and releases its budget', async (outcome) => {
    const ledger = new CommandLedger(undefined, { totalTurnResultByteLimit: 4 });
    const first = await ledger.accept(acceptedInput({ turnId: 'turn-first' }));
    await ledger.setTurnResult('chat-1', 'turn-first', { type: 'text', text: '1234' });
    if (outcome === 'interrupted') await ledger.markPublicTerminal('chat-1', 'turn-first', 'user-stop');
    else await ledger.update(first.record.key, { status: outcome });
    expect((await ledger.getTurnRecord('chat-1', 'turn-first')).turnResult).toEqual({
      availability: 'unavailable', reason: 'no-final-response',
    });
    await ledger.accept(acceptedInput({ clientRequestId: 'second', turnId: 'turn-second' }));
    await ledger.setTurnResult('chat-1', 'turn-second', { type: 'text', text: '5678' });
    expect((await ledger.getTurnRecord('chat-1', 'turn-second')).turnResult).toEqual({
      availability: 'available', text: '5678', bytes: 4,
    });
  });

  it('expires the oldest public result under aggregate pressure', async () => {
    const ledger = new CommandLedger(undefined, {
      turnResultByteLimit: 10,
      totalTurnResultByteLimit: 5,
    });
    const first = await ledger.accept(acceptedInput({ clientRequestId: 'first', turnId: 'turn-first' }));
    await ledger.setTurnResult('chat-1', 'turn-first', { type: 'text', text: '1234' });
    await ledger.settleTerminal(first.record.key, 'finished');
    await ledger.markPublicTerminal('chat-1', 'turn-first');
    const second = await ledger.accept(acceptedInput({ clientRequestId: 'second', turnId: 'turn-second' }));
    await ledger.setTurnResult('chat-1', 'turn-second', { type: 'text', text: '5678' });
    await ledger.settleTerminal(second.record.key, 'finished');
    await ledger.markPublicTerminal('chat-1', 'turn-second');

    expect(await ledger.getTurnRecord('chat-1', 'turn-first')).toMatchObject({
      turnResult: { availability: 'unavailable', reason: 'expired' },
    });
    expect(await ledger.getTurnRecord('chat-1', 'turn-second')).toMatchObject({
      turnResult: { availability: 'available', text: '5678' },
    });
  });

  it('bounds aggregate result memory while every retained turn is still pending', async () => {
    const ledger = new CommandLedger(undefined, {
      turnResultByteLimit: 10,
      totalTurnResultByteLimit: 5,
    });
    await ledger.accept(acceptedInput({ clientRequestId: 'first', turnId: 'turn-first' }));
    await ledger.accept(acceptedInput({ clientRequestId: 'second', turnId: 'turn-second' }));

    await ledger.setTurnResult('chat-1', 'turn-first', { type: 'text', text: '1234' });
    await ledger.setTurnResult('chat-1', 'turn-second', { type: 'text', text: '5678' });

    expect(await ledger.getTurnRecord('chat-1', 'turn-first')).toMatchObject({
      turnResult: { availability: 'available', text: '1234' },
    });
    expect(await ledger.getTurnRecord('chat-1', 'turn-second')).toMatchObject({
      turnResult: { availability: 'unavailable', reason: 'retention-pressure' },
    });
  });

  it('moves the turn index when a pre-schedule retry receives a new turn', async () => {
    const ledger = new CommandLedger();
    const first = await ledger.accept(acceptedInput({ turnId: 'turn-old' }));
    await ledger.update(first.record.key, {
      status: 'failed',
      errorCode: PRE_SCHEDULE_FAILURE_ERROR_CODE,
    });

    await ledger.accept(acceptedInput({ turnId: 'turn-new' }));

    expect(await ledger.getTurnRecord('chat-1', 'turn-old')).toBeNull();
    expect(await ledger.getTurnRecord('chat-1', 'turn-new')).not.toBeNull();
  });

  it('bounds private pre-schedule failures and releases their request payloads', async () => {
    const ledger = new CommandLedger(undefined, { recordLimit: 1 });
    const settlement = new ChatCommandSettlement(ledger);

    for (let index = 0; index < 3; index += 1) {
      const accepted = await ledger.accept(acceptedInput({
        clientRequestId: `request-${index}`,
        turnId: `turn-${index}`,
        payload: { chatId: 'chat-1', command: 'x'.repeat(1_024) },
      }));
      await settlement.markPreScheduleFailure(accepted.record, {
        error: new Error('busy'),
        retryable: true,
      });
    }

    expect(await ledger.getTurnRecord('chat-1', 'turn-0')).toBeNull();
    expect(await ledger.getTurnRecord('chat-1', 'turn-1')).toBeNull();
    expect(await ledger.getTurnRecord('chat-1', 'turn-2')).toMatchObject({
      payload: {},
      errorCode: PRE_SCHEDULE_FAILURE_ERROR_CODE,
    });
    expect(await ledger.accept(acceptedInput({
      clientRequestId: 'request-2',
      turnId: 'turn-retry',
      payload: { chatId: 'chat-1', command: 'changed' },
    }))).toMatchObject({ kind: 'conflict' });
    expect(await ledger.accept(acceptedInput({
      clientRequestId: 'request-2',
      turnId: 'turn-retry',
      payload: { chatId: 'chat-1', command: 'x'.repeat(1_024) },
    }))).toMatchObject({ kind: 'accepted', record: { turnId: 'turn-retry' } });
  });

  it('retains a non-retryable domain code for deterministic replay', async () => {
    const ledger = new CommandLedger();
    const settlement = new ChatCommandSettlement(ledger);
    const accepted = await ledger.accept(acceptedInput());

    await settlement.markPreScheduleFailure(accepted.record, {
      error: new DomainError(
        'PREAMBLE_SLASH_COMMAND_BLOCKED',
        'Start with a regular message.',
        422,
      ),
      retryable: false,
    });

    expect(await ledger.getRecord(accepted.record.key)).toMatchObject({
      status: 'failed',
      error: 'Start with a regular message.',
      errorCode: 'PREAMBLE_SLASH_COMMAND_BLOCKED',
    });
  });

  it('bounds accepted goal-control receipts with unknown outcomes', async () => {
    const ledger = new CommandLedger(undefined, { recordLimit: 1 });
    const settlement = new ChatCommandSettlement(ledger);
    const records = [];

    for (let index = 0; index < 3; index += 1) {
      const accepted = await ledger.accept(acceptedInput({
        commandType: 'goal-control',
        clientRequestId: `request-${index}`,
        turnId: `turn-${index}`,
      }));
      records.push(accepted.record);
      await settlement.settleGoalControlFailure(
        accepted.record,
        new Error('delivery outcome unknown'),
        true,
      );
    }

    expect(await ledger.getRecord(records[0].key)).toBeNull();
    expect(await ledger.getRecord(records[1].key)).toBeNull();
    expect(await ledger.getRecord(records[2].key)).toMatchObject({
      status: 'accepted',
      errorCode: GOAL_CONTROL_OUTCOME_UNKNOWN_ERROR_CODE,
    });
  });

  it('counts only public terminal records toward the retention limit', async () => {
    const ledger = new CommandLedger(undefined, { recordLimit: 1 });
    const first = await ledger.accept(acceptedInput({
      clientRequestId: 'first',
      turnId: 'turn-first',
    }));
    await ledger.settleTerminal(first.record.key, 'finished');

    await ledger.accept(acceptedInput({
      clientRequestId: 'second',
      turnId: 'turn-second',
    }));

    const privateTerminal = await ledger.getTurnRecord('chat-1', 'turn-first');
    expect(privateTerminal).toMatchObject({ status: 'finished' });
    expect(privateTerminal.publicTerminalAt).toBeUndefined();

    await ledger.markPublicTerminal('chat-1', 'turn-first');
    expect(await ledger.getTurnRecord('chat-1', 'turn-first')).not.toBeNull();

    const third = await ledger.accept(acceptedInput({
      clientRequestId: 'third',
      turnId: 'turn-third',
    }));
    await ledger.settleTerminal(third.record.key, 'finished');
    await ledger.markPublicTerminal('chat-1', 'turn-third');

    expect(await ledger.getTurnRecord('chat-1', 'turn-first')).toBeNull();
    expect(await ledger.getTurnRecord('chat-1', 'turn-third')).not.toBeNull();
  });

  it('evicts public terminal records by publication order', async () => {
    const ledger = new CommandLedger(undefined, { recordLimit: 1 });
    const first = await ledger.accept(acceptedInput({
      clientRequestId: 'first',
      turnId: 'turn-first',
    }));
    await ledger.settleTerminal(first.record.key, 'finished');

    const second = await ledger.accept(acceptedInput({
      clientRequestId: 'second',
      turnId: 'turn-second',
    }));
    await ledger.settleTerminal(second.record.key, 'finished');
    await ledger.markPublicTerminal('chat-1', 'turn-second');
    await ledger.markPublicTerminal('chat-1', 'turn-first');

    expect(await ledger.getTurnRecord('chat-1', 'turn-second')).toBeNull();
    expect(await ledger.getTurnRecord('chat-1', 'turn-first')).not.toBeNull();
  });

  it('expires aggregate results by publication order', async () => {
    const ledger = new CommandLedger(undefined, { totalTurnResultByteLimit: 8 });
    const first = await ledger.accept(acceptedInput({
      clientRequestId: 'first',
      turnId: 'turn-first',
    }));
    await ledger.setTurnResult('chat-1', 'turn-first', { type: 'text', text: '1234' });
    await ledger.settleTerminal(first.record.key, 'finished');

    const second = await ledger.accept(acceptedInput({
      clientRequestId: 'second',
      turnId: 'turn-second',
    }));
    await ledger.setTurnResult('chat-1', 'turn-second', { type: 'text', text: '5678' });
    await ledger.settleTerminal(second.record.key, 'finished');
    await ledger.markPublicTerminal('chat-1', 'turn-second');
    await ledger.markPublicTerminal('chat-1', 'turn-first');

    const third = await ledger.accept(acceptedInput({
      clientRequestId: 'third',
      turnId: 'turn-third',
    }));
    await ledger.setTurnResult('chat-1', 'turn-third', { type: 'text', text: 'abcd' });
    await ledger.settleTerminal(third.record.key, 'finished');
    await ledger.markPublicTerminal('chat-1', 'turn-third');

    expect(await ledger.getTurnRecord('chat-1', 'turn-second')).toMatchObject({
      turnResult: { availability: 'unavailable', reason: 'expired' },
    });
    expect(await ledger.getTurnRecord('chat-1', 'turn-first')).toMatchObject({
      turnResult: { availability: 'available', text: '1234' },
    });
  });

  it('keeps unsettled and fork-preparation records while trimming old terminal records', async () => {
    const ledger = new CommandLedger();
    const unsettled = await ledger.accept(acceptedInput({ clientRequestId: 'unsettled' }));
    const fork = await ledger.accept(acceptedInput({
      commandType: 'fork-run',
      clientRequestId: 'fork',
    }));
    await ledger.update(fork.record.key, {
      status: 'failed',
      forkPreparation: { phase: 'created', sourceChatId: 'source' },
    });

    for (let index = 0; index < LEDGER_RECORD_LIMIT + 5; index += 1) {
      const result = await ledger.accept(acceptedInput({ clientRequestId: `terminal-${index}` }));
      await ledger.settleTerminal(result.record.key, 'finished');
    }

    expect(await ledger.getRecord(unsettled.record.key)).not.toBeNull();
    expect(await ledger.getRecord(fork.record.key)).not.toBeNull();
    expect(await ledger.getRecord(commandLedgerKey('agent-run', 'chat-1', 'terminal-0'))).toBeNull();
  });

  it('retains compact steering identities for process-lifetime at-most-once delivery', async () => {
    const ledger = new CommandLedger();
    const steerInput = acceptedInput({
      commandType: 'steer',
      clientRequestId: 'steer-retained',
      payload: {
        chatId: 'chat-1',
        content: 'sensitive steering content',
        clientMessageId: 'message-retained',
      },
    });
    const steer = await ledger.accept(steerInput);
    await ledger.settleTerminal(steer.record.key, 'finished', { turnId: 'turn-1' });

    for (let index = 0; index < LEDGER_RECORD_LIMIT + 5; index += 1) {
      const result = await ledger.accept(acceptedInput({ clientRequestId: `terminal-${index}` }));
      await ledger.settleTerminal(result.record.key, 'finished');
    }

    expect(await ledger.accept(steerInput)).toMatchObject({
      kind: 'duplicate',
      record: { payload: {}, status: 'finished', turnId: 'turn-1' },
    });
    expect(await ledger.observe(steerInput)).toMatchObject({
      kind: 'duplicate',
      record: { payload: {}, status: 'finished', turnId: 'turn-1' },
    });
    expect(await ledger.accept({
      ...steerInput,
      payload: { ...steerInput.payload, content: 'changed content' },
    })).toMatchObject({ kind: 'conflict' });
    expect(await ledger.observe({
      ...steerInput,
      payload: { ...steerInput.payload, content: 'changed content' },
    })).toMatchObject({ kind: 'conflict' });
    expect(await ledger.accept(acceptedInput({
      commandType: 'agent-run',
      clientRequestId: 'steer-retained',
    }))).toMatchObject({ kind: 'conflict' });
  });

  it('retains queued source identity and delivery outcome in compact steering records', async () => {
    const ledger = new CommandLedger();
    const steerInput = acceptedInput({
      commandType: 'steer',
      clientRequestId: 'queued-steer-retained',
      entryId: 'entry-head',
      payload: {
        chatId: 'chat-1',
        clientMessageId: 'message-retained',
        source: {
          kind: 'queue-entry',
          entryId: 'entry-head',
          expectedRevision: 2,
          expectedReorderRevision: 4,
        },
      },
    });
    const steer = await ledger.accept(steerInput);
    await ledger.settleTerminal(steer.record.key, 'failed', {
      error: 'Delivery uncertain',
      errorCode: 'STEER_OUTCOME_UNKNOWN',
      deliveryOutcome: 'unknown',
    });

    for (let index = 0; index < LEDGER_RECORD_LIMIT + 5; index += 1) {
      const result = await ledger.accept(acceptedInput({ clientRequestId: `queued-terminal-${index}` }));
      await ledger.settleTerminal(result.record.key, 'finished');
    }

    expect(await ledger.accept(steerInput)).toMatchObject({
      kind: 'duplicate',
      record: {
        payload: {},
        status: 'failed',
        entryId: 'entry-head',
        errorCode: 'STEER_OUTCOME_UNKNOWN',
        deliveryOutcome: 'unknown',
      },
    });
  });

  it('bounds retained steering identities without evicting known outcomes', async () => {
    const ledger = new CommandLedger(undefined, { steerIdentityLimit: 2 });
    const first = acceptedInput({ commandType: 'steer', clientRequestId: 'steer-1' });
    const second = acceptedInput({ commandType: 'steer', clientRequestId: 'steer-2' });
    const firstResult = await ledger.accept(first);
    const secondResult = await ledger.accept(second);
    await ledger.settleTerminal(firstResult.record.key, 'finished', { turnId: 'turn-1' });
    await ledger.settleTerminal(secondResult.record.key, 'failed', {
      error: 'No active turn',
      errorCode: 'STEER_TURN_UNAVAILABLE',
    });

    await expect(ledger.accept(acceptedInput({
      commandType: 'steer',
      clientRequestId: 'steer-3',
    }))).rejects.toBeInstanceOf(SteerIdentityCapacityError);
    expect(await ledger.accept(first)).toMatchObject({
      kind: 'duplicate',
      record: { status: 'finished', turnId: 'turn-1' },
    });
    expect(await ledger.accept({ ...first, commandType: 'agent-run' })).toMatchObject({
      kind: 'conflict',
    });
    expect(await ledger.accept(acceptedInput({ clientRequestId: 'ordinary-after-capacity' })))
      .toMatchObject({ kind: 'accepted' });
    expect(await ledger.observe(acceptedInput({
      commandType: 'steer',
      clientRequestId: 'unseen-after-capacity',
    }))).toBeNull();
  });

  it('keeps the original receipt owner when several steers join one turn', async () => {
    const ledger = new CommandLedger();
    await ledger.accept(acceptedInput({
      commandType: 'agent-run',
      clientRequestId: 'owner-request',
      turnId: 'turn-shared',
    }));
    await ledger.accept(acceptedInput({
      commandType: 'steer',
      clientRequestId: 'steer-one',
      turnId: 'turn-shared',
    }));
    await ledger.accept(acceptedInput({
      commandType: 'steer',
      clientRequestId: 'steer-two',
      turnId: 'turn-shared',
    }));
    await ledger.setTurnResult('chat-1', 'turn-shared', { type: 'text', text: 'first\n\nsecond' });

    expect(await ledger.getTurnRecord('chat-1', 'turn-shared')).toMatchObject({
      commandType: 'agent-run',
      clientRequestId: 'owner-request',
      turnResult: { availability: 'available', text: 'first\n\nsecond' },
    });
    expect((await ledger.getRecord(commandLedgerKey('steer', 'chat-1', 'steer-one'))).turnResult).toBeUndefined();
    expect((await ledger.getRecord(commandLedgerKey('steer', 'chat-1', 'steer-two'))).turnResult).toBeUndefined();
  });

  it('does not share records between process-lifetime ledger instances', async () => {
    const first = new CommandLedger('/tmp/workspace');
    await first.accept(acceptedInput());

    const restarted = new CommandLedger('/tmp/workspace');

    expect(await restarted.getRecord(commandLedgerKey('agent-run', 'chat-1', 'request-1'))).toBeNull();
  });
});
