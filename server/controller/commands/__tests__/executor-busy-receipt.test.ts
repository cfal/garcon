import { expect, it } from 'bun:test';
import { AgentCallError } from '@garcon/server-agent-interface';
import { projectAgentTurnReceipt } from '../agent-turn-receipt-projector.js';
import { ChatCommandSettlement } from '../chat-command-settlement.js';
import { CommandLedger } from '../command-ledger.js';

it.each(['chat-start', 'agent-run'])('preserves executor admission pressure on the %s receipt', async commandType => {
  const ledger = new CommandLedger();
  const chatId = '1111111111111111';
  const turnId = 'synthetic-turn';
  const { record } = await ledger.accept({ commandType, chatId, turnId, clientRequestId: 'synthetic-request', payload: {} });
  await new ChatCommandSettlement(ledger).settleOperationFailure(record,
    new AgentCallError('not-dispatched', 'Executor is busy', 'EXECUTOR_BUSY'));
  await ledger.markPublicTerminal(chatId, turnId);
  const terminal = await ledger.waitForTurnTerminal(chatId, turnId, new AbortController().signal);
  if (!terminal) throw new Error('Missing terminal record');
  expect(projectAgentTurnReceipt(terminal)).toMatchObject({ receipt: { state: 'failed', errorCode: 'EXECUTOR_BUSY' } });
});
