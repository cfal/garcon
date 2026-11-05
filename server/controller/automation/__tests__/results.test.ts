import { expect, test } from 'bun:test';
import { AgentCallError } from '@garcon/server-agent-interface';
import type { CommandOutcome } from '../../../../common/command-output.js';
import { CommandLedger } from '../../commands/command-ledger.js';
import { ChatCommandSettlement } from '../../commands/chat-command-settlement.js';
import { automationTerminalResult } from '../results.js';

const outcome: CommandOutcome = { outcome: 'failed', exitCode: 7, signal: null,
  cwd: { kind: 'reported', path: '/synthetic' }, capture: 'complete' };
async function pending() {
  const ledger = new CommandLedger();
  const accepted = await ledger.accept({ commandType: 'chat-start', chatId: 'synthetic', clientRequestId: 'request', turnId: 'turn', payload: {} });
  return { ledger, command: { key: accepted.record.key, chatId: 'synthetic', clientRequestId: 'request', turnId: 'turn' } };
}
test('exact-turn runtime scope survives projection and is never inferred from a current executor', async () => {
  const { ledger, command } = await pending();
  const executionScope = { executorId: 'local', instanceId: 'synthetic-execution-runtime' };
  ledger.recordExecutionEvidence('synthetic', 'turn', { executionScope, outcome: 'failed', origin: 'provider',
    failureCertainty: 'definite', commandOutcome: outcome, receivedOutputCoverage: 'complete' });
  executionScope.instanceId = 'replacement';
  await ledger.settleTerminal(command.key, 'failed');
  await ledger.markPublicTerminal('synthetic', 'turn');
  expect(automationTerminalResult(await ledger.getTurnRecord('synthetic', 'turn')).executionScope)
    .toEqual({ executorId: 'local', instanceId: 'synthetic-execution-runtime' });
  expect(automationTerminalResult(null).executionScope).toBeNull();
});
test.each(['not-dispatched', 'rejected', 'unknown'] as const)('preserves %s delivery evidence before generic error projection', async delivery => {
  const { ledger, command } = await pending();
  await new ChatCommandSettlement(ledger).settleOperationFailure(command, new AgentCallError(delivery, 'Synthetic failure'));
  await ledger.markPublicTerminal('synthetic', 'turn');
  const result = automationTerminalResult(await ledger.getTurnRecord('synthetic', 'turn'));
  expect(result).toMatchObject({ kind: 'failed', certainty: delivery === 'not-dispatched' ? 'not-started' : delivery === 'rejected' ? 'definite' : 'unknown' });
});
test('terminal metadata survives an earlier failed settlement and never upgrades unknown to retryable', async () => {
  const { ledger, command } = await pending();
  await ledger.settleTerminal(command.key, 'failed', { errorCode: 'INTERNAL_ERROR' });
  ledger.recordExecutionEvidence('synthetic', 'turn', { executionScope: null, outcome: 'failed', origin: 'core', failureCertainty: 'unknown',
    commandOutcome: null, receivedOutputCoverage: 'gapped' });
  await ledger.markPublicTerminal('synthetic', 'turn');
  expect(automationTerminalResult(await ledger.getTurnRecord('synthetic', 'turn'))).toMatchObject({ kind: 'failed', certainty: 'unknown', receivedOutputCoverage: 'gapped' });
});
test('cleanup aggregation cannot erase previously captured delivery evidence', async () => {
  const { ledger, command } = await pending();
  const settlement = new ChatCommandSettlement(ledger);
  const original = new AgentCallError('not-dispatched', 'Synthetic non-dispatch');
  settlement.recordOperationFailure(command, original);
  await settlement.settleOperationFailure(command, new AggregateError([original, new Error('Synthetic cleanup failure')]));
  await ledger.markPublicTerminal('synthetic', 'turn');
  expect(automationTerminalResult(await ledger.getTurnRecord('synthetic', 'turn'))).toMatchObject({ kind: 'failed', certainty: 'not-started' });
});
test('nonzero exits and provider interruptions retain structured command evidence', async () => {
  for (const status of ['failed', 'interrupted'] as const) {
    const { ledger, command } = await pending();
    ledger.recordExecutionEvidence('synthetic', 'turn', { executionScope: null, outcome: status, origin: 'provider', failureCertainty: 'definite',
      commandOutcome: outcome, receivedOutputCoverage: 'complete' });
    await ledger.settleTerminal(command.key, status === 'failed' ? 'failed' : 'finished');
    await ledger.markPublicTerminal('synthetic', 'turn');
    expect(automationTerminalResult(await ledger.getTurnRecord('synthetic', 'turn'))).toMatchObject({ kind: status, commandOutcome: outcome });
  }
});

test('a failed settlement after completed execution is never retryable failure evidence', async () => {
  const { ledger, command } = await pending();
  ledger.recordExecutionEvidence('synthetic', 'turn', { executionScope: null, outcome: 'finished', origin: 'provider', failureCertainty: 'definite',
    commandOutcome: { ...outcome, outcome: 'finished', exitCode: 0 }, receivedOutputCoverage: 'complete' });
  await ledger.settleTerminal(command.key, 'failed', { errorCode: 'PROJECT_PATH_DESTINATION_REJECTED' });
  await ledger.markPublicTerminal('synthetic', 'turn');
  expect(automationTerminalResult(await ledger.getTurnRecord('synthetic', 'turn')))
    .toMatchObject({ kind: 'failed', certainty: 'unknown', commandOutcome: { outcome: 'finished', exitCode: 0 } });
});

test('cleanup failure after observed Shell interruption remains nonretryable interruption', async () => {
  const { ledger, command } = await pending();
  ledger.recordExecutionEvidence('synthetic', 'turn', { executionScope: null, outcome: 'failed', origin: 'provider', failureCertainty: 'definite',
    commandOutcome: { ...outcome, outcome: 'interrupted', exitCode: null, signal: 'SIGTERM' }, receivedOutputCoverage: 'complete' });
  await ledger.settleTerminal(command.key, 'failed', { errorCode: 'INTERNAL_ERROR', error: 'Synthetic cleanup failure.' });
  await ledger.markPublicTerminal('synthetic', 'turn');
  expect(automationTerminalResult(await ledger.getTurnRecord('synthetic', 'turn')))
    .toMatchObject({ kind: 'interrupted', termination: 'observed', commandOutcome: { outcome: 'interrupted' } });
});
