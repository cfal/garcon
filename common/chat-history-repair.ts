import { isRecord } from './json.js';
import {
  CommandRequestValidationError,
  parseRepairHistoryAcceptNativeRequest,
} from './chat-command-contracts.js';

export interface RepairHistoryAcceptNativeRequest {
  action: 'accept-native';
  chatId: string;
  expectedCarryOverRevision: string;
  expectedAgentOwnershipEpoch: string;
}

export interface RepairHistoryAcceptNativeResponse {
  success: true;
  action: 'accept-native';
  chatId: string;
  receiptCleared: boolean;
}

export interface RepairHistoryRetryAbandonedRequest {
  action: 'retry-abandoned-release';
}

// Content-free by design: enough for an operator to see what is stuck, never
// provider transcript material.
export interface AbandonedReleaseMaintenanceRecord {
  chatId: string;
  agentId: string;
  lastErrorCode: string | null;
}

export interface RepairHistoryRetryAbandonedResponse {
  success: true;
  action: 'retry-abandoned-release';
  retried: AbandonedReleaseMaintenanceRecord[];
  // Every retried record still held after the retry, pending or re-abandoned.
  unresolved: AbandonedReleaseMaintenanceRecord[];
}

export type RepairHistoryRequest =
  | RepairHistoryAcceptNativeRequest
  | RepairHistoryRetryAbandonedRequest;

export type RepairHistoryResponse =
  | RepairHistoryAcceptNativeResponse
  | RepairHistoryRetryAbandonedResponse;

// The parsers live beside the contracts rather than in chat-command-contracts,
// which is at its architecture-budget ceiling.
export function parseRepairHistoryRetryAbandonedRequest(
  value: unknown,
): RepairHistoryRetryAbandonedRequest {
  if (!isRecord(value) || value.action !== 'retry-abandoned-release') {
    throw new CommandRequestValidationError('action must be retry-abandoned-release');
  }
  return { action: 'retry-abandoned-release' };
}

export function parseRepairHistoryRequest(value: unknown): RepairHistoryRequest {
  if (!isRecord(value)) throw new CommandRequestValidationError('request body must be an object');
  if (value.action === 'accept-native') return parseRepairHistoryAcceptNativeRequest(value);
  if (value.action === 'retry-abandoned-release') {
    return parseRepairHistoryRetryAbandonedRequest(value);
  }
  throw new CommandRequestValidationError(
    'action must be accept-native or retry-abandoned-release',
  );
}
