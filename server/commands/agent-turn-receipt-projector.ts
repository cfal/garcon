import type { AgentTurnOutput, AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import type { CommandLedgerRecord } from './command-ledger.js';
import { isErrorCode } from '../../common/error-codes.js';

export type AgentTurnReceiptProjection =
  | { kind: 'found'; receipt: AgentTurnReceipt }
  | { kind: 'expired' };

export function projectAgentTurnReceipt(record: CommandLedgerRecord): AgentTurnReceiptProjection {
  if (record.turnResult?.availability === 'unavailable' && record.turnResult.reason === 'expired') return { kind: 'expired' };
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
        output: { availability: 'unavailable', reason: 'no-final-response' },
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
        errorCode: isErrorCode(record.errorCode) ? record.errorCode : 'INTERNAL_ERROR',
        output: { availability: 'unavailable', reason: 'no-final-response' },
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
  if (record.status !== 'finished' || record.interruptionReason || !record.turnResult) {
    return { availability: 'unavailable', reason: 'no-final-response' };
  }
  if (record.turnResult.availability === 'unavailable') {
    return { availability: 'unavailable', reason: record.turnResult.reason === 'expired'
      ? 'no-final-response' : record.turnResult.reason };
  }
  return {
    availability: 'available',
    completeness: 'complete',
    text: record.turnResult.text,
  };
}
