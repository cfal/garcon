import crypto from 'node:crypto';
import type { TurnReceiptOwner } from '../lib/turn-identity.js';
import type { AgentChatEntry, AgentExecutionCommandType } from './session-types.js';

// Identifies one launched operation for turn receipts and execution events.
export interface TurnOperation extends TurnReceiptOwner {
  readonly clientMessageId: string | null;
  readonly turnOwner: TurnReceiptOwner;
}

export function operationIdentity(
  entry: Pick<AgentChatEntry, 'agentOwnershipEpoch'>,
  value: { clientRequestId?: string; clientMessageId?: string; turnId?: string },
  commandType: AgentExecutionCommandType,
): TurnOperation {
  if (!entry.agentOwnershipEpoch) throw new Error('Agent ownership epoch is required');
  const clientRequestId = value.clientRequestId ?? crypto.randomUUID();
  const turnId = value.turnId ?? crypto.randomUUID();
  const turnOwner = {
    agentOwnershipEpoch: entry.agentOwnershipEpoch,
    commandType,
    clientRequestId,
    turnId,
  } as const;
  return {
    agentOwnershipEpoch: entry.agentOwnershipEpoch,
    commandType,
    clientRequestId,
    clientMessageId: value.clientMessageId ?? null,
    turnId,
    turnOwner,
  };
}

export function operationMetadata(operation: TurnOperation) {
  return {
    commandType: operation.commandType,
    ...(operation.clientRequestId ? { clientRequestId: operation.clientRequestId } : {}),
    turnId: operation.turnId,
    agentOwnershipEpoch: operation.agentOwnershipEpoch,
    turnOwner: operation.turnOwner,
  };
}
