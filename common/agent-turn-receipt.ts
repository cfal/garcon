export type AgentTurnOutputCompleteness = 'complete' | 'best-effort';

export interface AgentTurnOutputAvailable {
  availability: 'available';
  completeness: AgentTurnOutputCompleteness;
  assistantMessages: string[];
}

export interface AgentTurnOutputUnavailable {
  availability: 'unavailable';
  reason: 'too-large' | 'retention-pressure';
}

export type AgentTurnOutput = AgentTurnOutputAvailable | AgentTurnOutputUnavailable;

interface AgentTurnReceiptBase {
  chatId: string;
  turnId: string;
  clientRequestId: string;
  acceptedAt: string;
  updatedAt: string;
}

export interface PendingAgentTurnReceipt extends AgentTurnReceiptBase {
  state: 'pending';
}

export interface CompletedAgentTurnReceipt extends AgentTurnReceiptBase {
  state: 'completed';
  settledAt: string;
  output: AgentTurnOutput;
}

export interface FailedAgentTurnReceipt extends AgentTurnReceiptBase {
  state: 'failed';
  settledAt: string;
  error: string;
  output: AgentTurnOutput;
}

export interface InterruptedAgentTurnReceipt extends AgentTurnReceiptBase {
  state: 'interrupted';
  settledAt: string;
  reason: 'user-stop' | 'chat-deleted';
  output: AgentTurnOutput;
}

export type AgentTurnReceipt =
  | PendingAgentTurnReceipt
  | CompletedAgentTurnReceipt
  | FailedAgentTurnReceipt
  | InterruptedAgentTurnReceipt;

export class AgentTurnReceiptContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTurnReceiptContractError';
  }
}

export function parseAgentTurnReceipt(value: unknown): AgentTurnReceipt {
  const raw = record(value, 'turn receipt');
  const base = {
    chatId: requiredString(raw, 'chatId'),
    turnId: requiredString(raw, 'turnId'),
    clientRequestId: requiredString(raw, 'clientRequestId'),
    acceptedAt: requiredString(raw, 'acceptedAt'),
    updatedAt: requiredString(raw, 'updatedAt'),
  };
  if (raw.state === 'pending') return { ...base, state: 'pending' };
  const settledAt = requiredString(raw, 'settledAt');
  if (raw.state === 'completed') {
    return { ...base, state: 'completed', settledAt, output: parseOutput(raw.output) };
  }
  if (raw.state === 'failed') {
    return {
      ...base,
      state: 'failed',
      settledAt,
      error: requiredString(raw, 'error'),
      output: parseOutput(raw.output),
    };
  }
  if (raw.state === 'interrupted') {
    if (raw.reason !== 'user-stop' && raw.reason !== 'chat-deleted') {
      throw new AgentTurnReceiptContractError('interruption reason is invalid');
    }
    return {
      ...base,
      state: 'interrupted',
      settledAt,
      reason: raw.reason,
      output: parseOutput(raw.output),
    };
  }
  throw new AgentTurnReceiptContractError('turn receipt state is invalid');
}

function parseOutput(value: unknown): AgentTurnOutput {
  const raw = record(value, 'turn output');
  if (raw.availability === 'unavailable') {
    if (raw.reason !== 'too-large' && raw.reason !== 'retention-pressure') {
      throw new AgentTurnReceiptContractError('turn output reason is invalid');
    }
    return { availability: 'unavailable', reason: raw.reason };
  }
  if (raw.availability !== 'available') {
    throw new AgentTurnReceiptContractError('turn output availability is invalid');
  }
  if (raw.completeness !== 'complete' && raw.completeness !== 'best-effort') {
    throw new AgentTurnReceiptContractError('turn output completeness is invalid');
  }
  if (!Array.isArray(raw.assistantMessages)
    || !raw.assistantMessages.every((message) => typeof message === 'string')) {
    throw new AgentTurnReceiptContractError('assistantMessages must be a string array');
  }
  return {
    availability: 'available',
    completeness: raw.completeness,
    assistantMessages: [...raw.assistantMessages],
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentTurnReceiptContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentTurnReceiptContractError(`${field} must be a non-empty string`);
  }
  return value;
}
