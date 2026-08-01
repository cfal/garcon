import type { AgentTurnOutput, AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import type { CommandLedgerRecord } from './command-ledger.js';

export type AgentTurnReceiptProjection =
  | { kind: 'found'; receipt: AgentTurnReceipt }
  | { kind: 'expired' };

export function projectAgentTurnReceipt(
  record: CommandLedgerRecord,
): AgentTurnReceiptProjection {
  if (record.turnResultAvailability === 'expired') return { kind: 'expired' };
  const base = {
    chatId: record.chatId,
    turnId: record.turnId ?? '',
    clientRequestId: record.clientRequestId,
    acceptedAt: record.acceptedAt,
    updatedAt: record.updatedAt,
  };
  if (!record.publicTerminalAt) {
    return { kind: 'found', receipt: { ...base, state: 'pending' } };
  }
  const output = projectOutput(record);
  if (record.interruptionReason) {
    return {
      kind: 'found',
      receipt: {
        ...base,
        state: 'interrupted',
        settledAt: record.publicTerminalAt,
        reason: record.interruptionReason,
        output,
      },
    };
  }
  if (record.status === 'failed' || record.status === 'rejected') {
    return {
      kind: 'found',
      receipt: {
        ...base,
        state: 'failed',
        settledAt: record.publicTerminalAt,
        error: record.error ?? 'Agent turn failed',
        output,
      },
    };
  }
  return {
    kind: 'found',
    receipt: {
      ...base,
      state: 'completed',
      settledAt: record.publicTerminalAt,
      output,
    },
  };
}

function projectOutput(record: CommandLedgerRecord): AgentTurnOutput {
  if (record.turnResultAvailability === 'too-large') {
    return { availability: 'unavailable', reason: 'too-large' };
  }
  if (record.turnResultAvailability === 'retention-pressure') {
    return { availability: 'unavailable', reason: 'retention-pressure' };
  }
  if (record.turnResultAvailability === 'recovery') {
    return { availability: 'unavailable', reason: 'recovery' };
  }
  return {
    availability: 'available',
    completeness: record.status === 'finished' && !record.interruptionReason
      ? 'complete'
      : 'best-effort',
    assistantMessages: [...(record.assistantMessages ?? [])],
  };
}
