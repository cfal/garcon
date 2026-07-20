import { describe, expect, it } from 'bun:test';
import {
  CommandLedger,
  LEDGER_RECORD_LIMIT,
  PRE_SCHEDULE_FAILURE_ERROR_CODE,
  commandLedgerKey,
  commandPayloadHash,
} from '../command-ledger.ts';

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
    await ledger.settleTerminal(first.record.key, 'finished');

    expect(ledger.unsettledQueueReceiptKeys('chat-1')).toEqual(new Set([second.record.key]));
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

  it('does not share records between process-lifetime ledger instances', async () => {
    const first = new CommandLedger('/tmp/workspace');
    await first.accept(acceptedInput());

    const restarted = new CommandLedger('/tmp/workspace');

    expect(await restarted.getRecord(commandLedgerKey('agent-run', 'chat-1', 'request-1'))).toBeNull();
  });
});
