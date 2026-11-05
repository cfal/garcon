import type { AutomationResult } from '../../../common/automation.js';
import { projectAgentTurnReceipt } from '../commands/agent-turn-receipt-projector.js';
import type { CommandLedgerRecord } from '../commands/command-ledger.js';

export function automationTerminalResult(record: CommandLedgerRecord | null): AutomationResult {
  const evidence = {
    executionScope: record?.executionEvidence?.executionScope ?? null,
    commandOutcome: record?.executionEvidence?.commandOutcome ?? null,
    receivedOutputCoverage: record?.executionEvidence?.receivedOutputCoverage ?? 'unknown',
  } as const;
  if (!record) return { ...evidence, kind: 'unavailable', reason: 'The process-local turn observation is unavailable.' };
  const projection = projectAgentTurnReceipt(record);
  if (projection.kind === 'expired') return { ...evidence, kind: 'unavailable', reason: 'The turn observation expired.' };
  const receipt = projection.receipt;
  if (receipt.state === 'pending') return { ...evidence, kind: 'unavailable', reason: 'No public terminal observation.' };
  if (receipt.state === 'interrupted' || record.executionEvidence?.outcome === 'interrupted'
    || evidence.commandOutcome?.outcome === 'interrupted') {
    return { ...evidence, kind: 'interrupted', receipt: receipt.state === 'interrupted' ? receipt : null,
      termination: record.executionEvidence?.origin === 'provider' ? 'observed' : 'requested' };
  }
  if (receipt.state === 'completed') return { ...evidence, kind: 'completed', receipt };
  const terminal = record.executionEvidence;
  const certainty = terminal?.outcome === 'finished' || terminal?.commandOutcome?.outcome === 'finished'
    || terminal?.commandOutcome?.outcome === 'unknown' || terminal?.failureCertainty === 'unknown' || record.dispatchFailure === 'unknown' ? 'unknown'
    : terminal?.failureCertainty ?? (record.dispatchFailure === 'not-dispatched' ? 'not-started'
      : record.dispatchFailure === 'rejected' ? 'definite' : 'unknown');
  return { ...evidence, kind: 'failed', certainty, receipt, detail: receipt.error };
}
