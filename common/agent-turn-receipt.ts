import { isErrorCode, type ErrorCode } from './error-codes.js';

export type AgentTurnOutputCompleteness = 'complete' | 'best-effort';

export interface AgentTurnOutputAvailable {
  availability: 'available';
  completeness: AgentTurnOutputCompleteness;
  text: string;
}

export interface AgentTurnOutputUnavailable {
  availability: 'unavailable';
  reason: 'no-final-response' | 'too-large' | 'retention-pressure';
}

export type AgentTurnOutput = AgentTurnOutputAvailable | AgentTurnOutputUnavailable;

export interface AgentTurnNoFinalResponse {
  availability: 'unavailable';
  reason: 'no-final-response';
}

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
  errorCode: ErrorCode;
  output: AgentTurnNoFinalResponse;
}

export interface InterruptedAgentTurnReceipt extends AgentTurnReceiptBase {
  state: 'interrupted';
  settledAt: string;
  reason: 'user-stop' | 'chat-deleted';
  output: AgentTurnNoFinalResponse;
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
    if (!isErrorCode(raw.errorCode)) {
      throw new AgentTurnReceiptContractError('errorCode must be a registered error code');
    }
    return {
      ...base,
      state: 'failed',
      settledAt,
      error: requiredString(raw, 'error'),
      errorCode: raw.errorCode,
      output: parseUnsuccessfulOutput(raw.output),
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
      output: parseUnsuccessfulOutput(raw.output),
    };
  }
  throw new AgentTurnReceiptContractError('turn receipt state is invalid');
}

function parseOutput(value: unknown): AgentTurnOutput {
  const raw = record(value, 'turn output');
  if (raw.availability === 'unavailable') {
    if (
      raw.reason !== 'too-large'
      && raw.reason !== 'retention-pressure'
      && raw.reason !== 'no-final-response'
    ) {
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
  if (typeof raw.text !== 'string') {
    throw new AgentTurnReceiptContractError('text must be a string');
  }
  return {
    availability: 'available',
    completeness: raw.completeness,
    text: raw.text,
  };
}

function parseUnsuccessfulOutput(value: unknown): AgentTurnNoFinalResponse {
  const output = parseOutput(value);
  if (output.availability !== 'unavailable' || output.reason !== 'no-final-response') {
    throw new AgentTurnReceiptContractError('unsuccessful turns cannot expose a final response');
  }
  return { availability: 'unavailable', reason: 'no-final-response' };
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
