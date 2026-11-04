import { expect, test } from 'bun:test';
import { CommandLedger } from '../../commands/command-ledger.js';

const input = { chatId: 'synthetic', clientRequestId: 'request', turnId: 'turn', payload: {} };

test('reservation is indexed before consumption and consumed exactly once', async () => {
  const ledger = new CommandLedger();
  const reserved = ledger.reserveStart(input);
  expect(reserved.kind).toBe('accepted');
  expect(reserved.record.status).toBe('reserved');
  const terminal = ledger.waitForTurnTerminal(input.chatId, input.turnId, new AbortController().signal);
  expect((await ledger.accept({ ...input, commandType: 'chat-start' })).kind).toBe('conflict');
  expect(ledger.reserveStart(input).kind).toBe('conflict');
  expect(ledger.consumeStartReservation(reserved.record.key, input.turnId)?.status).toBe('accepted');
  expect(ledger.consumeStartReservation(reserved.record.key, input.turnId)).toBeNull();
  await ledger.settleTerminal(reserved.record.key, 'finished');
  await ledger.markPublicTerminal(input.chatId, input.turnId);
  expect((await terminal)?.turnId).toBe(input.turnId);
});

test('cancel settles privately and never reopens the same turn', async () => {
  const ledger = new CommandLedger();
  const reserved = ledger.reserveStart(input);
  const terminal = ledger.waitForTurnTerminal(input.chatId, input.turnId, new AbortController().signal);
  await ledger.cancelStartReservation(reserved.record.key);
  expect(await terminal).toBeNull();
  expect(ledger.consumeStartReservation(reserved.record.key, input.turnId)).toBeNull();
  const retry = await ledger.accept({ ...input, commandType: 'chat-start' });
  expect(retry.kind).toBe('duplicate');
  expect(retry.record).toMatchObject({ status: 'failed', retainedPrivateTerminal: true });
});
