import { describe, expect, it } from 'bun:test';
import {
  CommandLedger,
  LEDGER_RECORD_LIMIT,
  PRE_SCHEDULE_FAILURE_ERROR_CODE,
  SteerIdentityCapacityError,
  commandLedgerKey,
  commandPayloadHash,
} from '../command-ledger.ts';
import { ChatCommandSettlement } from '../chat-command-settlement.ts';

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
    expect(ledger.isTerminal(accepted.record.key)).toBe(true);
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

    await ledger.appendAssistantMessages('chat-1', 'turn-1', ['first', 'second']);
    await ledger.settleTerminal(accepted.record.key, 'finished');
    const terminal = await ledger.getTurnRecord('chat-1', 'turn-1');
    expect(terminal).toMatchObject({
      status: 'finished',
      assistantMessages: ['first', 'second'],
      payload: {},
    });
    expect(terminal.publicTerminalAt).toBeUndefined();

    await ledger.markPublicTerminal('chat-1', 'turn-1');
    expect(await ledger.getTurnRecord('chat-1', 'turn-1')).toMatchObject({
      publicTerminalAt: expect.any(String),
      turnResultAvailability: 'available',
    });
  });

  it('publishes a naturally completed turn when a rejected stop releases its barrier', async () => {
    const ledger = new CommandLedger();
    const accepted = await ledger.accept(acceptedInput({ turnId: 'turn-1' }));

    await ledger.settleTerminal(accepted.record.key, 'finished');
    await ledger.publishDeferredTerminal('chat-1', 'turn-1');

    expect(await ledger.getTurnRecord('chat-1', 'turn-1')).toMatchObject({
      status: 'finished',
      publicTerminalAt: expect.any(String),
    });
  });

  it('keeps a running turn private when a rejected stop releases its barrier', async () => {
    const ledger = new CommandLedger();
    await ledger.accept(acceptedInput({ turnId: 'turn-1' }));

    await ledger.publishDeferredTerminal('chat-1', 'turn-1');

    const record = await ledger.getTurnRecord('chat-1', 'turn-1');
    expect(record).toMatchObject({ status: 'accepted' });
    expect(record.publicTerminalAt).toBeUndefined();
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

    await ledger.appendAssistantMessages('chat-1', 'turn-large', ['1234']);
    await ledger.appendAssistantMessages('chat-1', 'turn-large', ['56']);

    expect(await ledger.getTurnRecord('chat-1', 'turn-large')).toMatchObject({
      turnResultAvailability: 'too-large',
      assistantBytes: 0,
    });
    expect((await ledger.getTurnRecord('chat-1', 'turn-large')).assistantMessages).toBeUndefined();
  });

  it('ignores empty assistant entries and bounds tiny-message arrays', async () => {
    const ledger = new CommandLedger(undefined, {
      turnResultByteLimit: 100,
      totalTurnResultByteLimit: 100,
      turnResultMessageLimit: 2,
      totalTurnResultMessageLimit: 10,
    });
    await ledger.accept(acceptedInput({ turnId: 'turn-many' }));

    await ledger.appendAssistantMessages('chat-1', 'turn-many', Array(10_000).fill(''));
    expect(await ledger.getTurnRecord('chat-1', 'turn-many')).toMatchObject({
      turnResultAvailability: 'available',
      assistantMessages: [],
      assistantBytes: 0,
    });

    await ledger.appendAssistantMessages('chat-1', 'turn-many', ['a', 'b', 'c']);
    expect(await ledger.getTurnRecord('chat-1', 'turn-many')).toMatchObject({
      turnResultAvailability: 'too-large',
      assistantBytes: 0,
    });
    expect((await ledger.getTurnRecord('chat-1', 'turn-many')).assistantMessages).toBeUndefined();
  });

  it('expires the oldest public result under aggregate pressure', async () => {
    const ledger = new CommandLedger(undefined, {
      turnResultByteLimit: 10,
      totalTurnResultByteLimit: 5,
    });
    const first = await ledger.accept(acceptedInput({ clientRequestId: 'first', turnId: 'turn-first' }));
    await ledger.appendAssistantMessages('chat-1', 'turn-first', ['1234']);
    await ledger.settleTerminal(first.record.key, 'finished');
    await ledger.markPublicTerminal('chat-1', 'turn-first');
    const second = await ledger.accept(acceptedInput({ clientRequestId: 'second', turnId: 'turn-second' }));
    await ledger.appendAssistantMessages('chat-1', 'turn-second', ['5678']);
    await ledger.settleTerminal(second.record.key, 'finished');
    await ledger.markPublicTerminal('chat-1', 'turn-second');

    expect(await ledger.getTurnRecord('chat-1', 'turn-first')).toMatchObject({
      turnResultAvailability: 'expired',
    });
    expect(await ledger.getTurnRecord('chat-1', 'turn-second')).toMatchObject({
      turnResultAvailability: 'available',
      assistantMessages: ['5678'],
    });
  });

  it('bounds aggregate result memory while every retained turn is still pending', async () => {
    const ledger = new CommandLedger(undefined, {
      turnResultByteLimit: 10,
      totalTurnResultByteLimit: 5,
    });
    await ledger.accept(acceptedInput({ clientRequestId: 'first', turnId: 'turn-first' }));
    await ledger.accept(acceptedInput({ clientRequestId: 'second', turnId: 'turn-second' }));

    await ledger.appendAssistantMessages('chat-1', 'turn-first', ['1234']);
    await ledger.appendAssistantMessages('chat-1', 'turn-second', ['5678']);

    expect(await ledger.getTurnRecord('chat-1', 'turn-first')).toMatchObject({
      turnResultAvailability: 'available',
      assistantMessages: ['1234'],
      assistantBytes: 4,
    });
    expect(await ledger.getTurnRecord('chat-1', 'turn-second')).toMatchObject({
      turnResultAvailability: 'retention-pressure',
      assistantBytes: 0,
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
    await ledger.appendAssistantMessages('chat-1', 'turn-first', ['1234']);
    await ledger.settleTerminal(first.record.key, 'finished');

    const second = await ledger.accept(acceptedInput({
      clientRequestId: 'second',
      turnId: 'turn-second',
    }));
    await ledger.appendAssistantMessages('chat-1', 'turn-second', ['5678']);
    await ledger.settleTerminal(second.record.key, 'finished');
    await ledger.markPublicTerminal('chat-1', 'turn-second');
    await ledger.markPublicTerminal('chat-1', 'turn-first');

    const third = await ledger.accept(acceptedInput({
      clientRequestId: 'third',
      turnId: 'turn-third',
    }));
    await ledger.appendAssistantMessages('chat-1', 'turn-third', ['abcd']);
    await ledger.settleTerminal(third.record.key, 'finished');
    await ledger.markPublicTerminal('chat-1', 'turn-third');

    expect(await ledger.getTurnRecord('chat-1', 'turn-second')).toMatchObject({
      turnResultAvailability: 'expired',
    });
    expect(await ledger.getTurnRecord('chat-1', 'turn-first')).toMatchObject({
      turnResultAvailability: 'available',
      assistantMessages: ['1234'],
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

  it('does not share records between process-lifetime ledger instances', async () => {
    const first = new CommandLedger('/tmp/workspace');
    await first.accept(acceptedInput());

    const restarted = new CommandLedger('/tmp/workspace');

    expect(await restarted.getRecord(commandLedgerKey('agent-run', 'chat-1', 'request-1'))).toBeNull();
  });
});
