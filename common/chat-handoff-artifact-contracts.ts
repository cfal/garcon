import { parseChatId } from './chat-id.js';
import {
  isHandoffContextWindowTokens,
  usableHandoffTokenBudget,
} from './handoff-sizing.js';

export interface ChatHandoffArtifactRequest {
  readonly chatId: string;
  readonly contextWindowTokens: number;
}

export interface ChatHandoffArtifactResponse {
  readonly success: true;
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly lastOrdinal: number;
  readonly generatedAt: string;
  readonly contextWindowTokens: number;
  readonly usableTokenBudget: number;
  readonly estimatedTokens: number;
  readonly totalEntryCount: number;
  readonly includedEntryCount: number;
  readonly omittedEntryCount: number;
  readonly abridgedEntryCount: number;
  readonly gapCount: number;
  readonly truncated: boolean;
  readonly documentCodeUnits: number;
  readonly document: string;
}

export class ChatHandoffArtifactContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatHandoffArtifactContractError';
  }
}

export function parseChatHandoffArtifactResponse(value: unknown): ChatHandoffArtifactResponse {
  const raw = record(value, 'handoff artifact response');
  if (raw.success !== true) fail('success must be true');
  let chatId: string;
  try {
    chatId = parseChatId(raw.chatId);
  } catch {
    return fail('chatId is invalid');
  }
  const transcriptViewId = nonEmptyString(raw.transcriptViewId, 'transcriptViewId');
  const lastOrdinal = nonNegativeInteger(raw.lastOrdinal, 'lastOrdinal');
  const generatedAt = canonicalTimestamp(raw.generatedAt, 'generatedAt');
  if (!isHandoffContextWindowTokens(raw.contextWindowTokens)) {
    fail('contextWindowTokens is invalid');
  }
  const contextWindowTokens = raw.contextWindowTokens;
  const usableTokenBudget = nonNegativeInteger(raw.usableTokenBudget, 'usableTokenBudget');
  if (usableTokenBudget !== usableHandoffTokenBudget(contextWindowTokens)) {
    fail('usableTokenBudget is inconsistent with contextWindowTokens');
  }
  const estimatedTokens = nonNegativeInteger(raw.estimatedTokens, 'estimatedTokens');
  if (estimatedTokens > usableTokenBudget) fail('estimatedTokens exceeds usableTokenBudget');
  const totalEntryCount = nonNegativeInteger(raw.totalEntryCount, 'totalEntryCount');
  const includedEntryCount = nonNegativeInteger(raw.includedEntryCount, 'includedEntryCount');
  const omittedEntryCount = nonNegativeInteger(raw.omittedEntryCount, 'omittedEntryCount');
  if (includedEntryCount + omittedEntryCount !== totalEntryCount) {
    fail('entry counts are inconsistent');
  }
  const abridgedEntryCount = nonNegativeInteger(raw.abridgedEntryCount, 'abridgedEntryCount');
  if (abridgedEntryCount > includedEntryCount) {
    fail('abridgedEntryCount exceeds includedEntryCount');
  }
  const gapCount = nonNegativeInteger(raw.gapCount, 'gapCount');
  if (gapCount > omittedEntryCount || (omittedEntryCount === 0 && gapCount !== 0)) {
    fail('gapCount is inconsistent with omittedEntryCount');
  }
  if (typeof raw.truncated !== 'boolean') fail('truncated must be a boolean');
  const truncated = omittedEntryCount > 0 || abridgedEntryCount > 0;
  if (raw.truncated !== truncated) fail('truncated is inconsistent with entry counts');
  const documentCodeUnits = nonNegativeInteger(raw.documentCodeUnits, 'documentCodeUnits');
  if (typeof raw.document !== 'string' || !raw.document.endsWith('\n')) {
    fail('document must be a string ending in a newline');
  }
  if (raw.document.length !== documentCodeUnits) {
    fail('documentCodeUnits is inconsistent with document');
  }
  return {
    success: true,
    chatId,
    transcriptViewId,
    lastOrdinal,
    generatedAt,
    contextWindowTokens,
    usableTokenBudget,
    estimatedTokens,
    totalEntryCount,
    includedEntryCount,
    omittedEntryCount,
    abridgedEntryCount,
    gapCount,
    truncated,
    documentCodeUnits,
    document: raw.document,
  };
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${field} must be a non-negative integer`);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} is invalid`);
  return value;
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(`${field} is invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${field} is invalid`);
  }
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function fail(message: string): never {
  throw new ChatHandoffArtifactContractError(message);
}
