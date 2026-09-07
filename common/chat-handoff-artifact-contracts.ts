import { parseChatId } from './chat-id.js';
import { TRANSCRIPT_EXPORT_CATEGORIES } from './chat-export-contracts.js';
import {
  isHandoffContextWindowTokens,
  usableHandoffTokenBudget,
} from './handoff-sizing.js';

export interface ChatHandoffArtifactRequest {
  readonly chatId: string;
  readonly contextWindowTokens: number;
}

export const CHAT_HANDOFF_ARTIFACT_FOLD = 'handoff-v1' as const;
export const CHAT_HANDOFF_ARTIFACT_GAP_UNIT = 'eligible-entry' as const;
export const CHAT_HANDOFF_ARTIFACT_EXCLUSION_CATEGORIES = [
  'conversation',
  ...TRANSCRIPT_EXPORT_CATEGORIES,
] as const;

export type ChatHandoffArtifactExclusionCategory =
  (typeof CHAT_HANDOFF_ARTIFACT_EXCLUSION_CATEGORIES)[number];

export interface ChatHandoffArtifactExcludedEntryCount {
  readonly category: ChatHandoffArtifactExclusionCategory;
  readonly count: number;
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
  readonly fold: typeof CHAT_HANDOFF_ARTIFACT_FOLD;
  readonly gapUnit: typeof CHAT_HANDOFF_ARTIFACT_GAP_UNIT;
  readonly sourceEntryCount: number;
  readonly eligibleEntryCount: number;
  readonly excludedEntryCounts: readonly ChatHandoffArtifactExcludedEntryCount[];
  readonly includedEntryCount: number;
  readonly budgetOmittedEntryCount: number;
  readonly abridgedEntryCount: number;
  readonly gapCount: number;
  readonly projectionTruncated: boolean;
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
  if (raw.fold !== CHAT_HANDOFF_ARTIFACT_FOLD) fail('fold is invalid');
  if (raw.gapUnit !== CHAT_HANDOFF_ARTIFACT_GAP_UNIT) fail('gapUnit is invalid');
  const sourceEntryCount = nonNegativeInteger(raw.sourceEntryCount, 'sourceEntryCount');
  const eligibleEntryCount = nonNegativeInteger(raw.eligibleEntryCount, 'eligibleEntryCount');
  const excludedEntryCounts = parseExcludedEntryCounts(raw.excludedEntryCounts);
  if (
    eligibleEntryCount
      + excludedEntryCounts.reduce((sum, entry) => sum + entry.count, 0)
    !== sourceEntryCount
  ) {
    fail('source, eligible, and excluded entry counts are inconsistent');
  }
  const includedEntryCount = nonNegativeInteger(raw.includedEntryCount, 'includedEntryCount');
  const budgetOmittedEntryCount = nonNegativeInteger(
    raw.budgetOmittedEntryCount,
    'budgetOmittedEntryCount',
  );
  if (includedEntryCount + budgetOmittedEntryCount !== eligibleEntryCount) {
    fail('eligible, included, and budget-omitted entry counts are inconsistent');
  }
  const abridgedEntryCount = nonNegativeInteger(raw.abridgedEntryCount, 'abridgedEntryCount');
  if (abridgedEntryCount > includedEntryCount) {
    fail('abridgedEntryCount exceeds includedEntryCount');
  }
  const gapCount = nonNegativeInteger(raw.gapCount, 'gapCount');
  if (
    gapCount > budgetOmittedEntryCount
    || (budgetOmittedEntryCount === 0 && gapCount !== 0)
  ) {
    fail('gapCount is inconsistent with budgetOmittedEntryCount');
  }
  if (typeof raw.projectionTruncated !== 'boolean') {
    fail('projectionTruncated must be a boolean');
  }
  const projectionTruncated = budgetOmittedEntryCount > 0 || abridgedEntryCount > 0;
  if (raw.projectionTruncated !== projectionTruncated) {
    fail('projectionTruncated is inconsistent with entry counts');
  }
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
    fold: CHAT_HANDOFF_ARTIFACT_FOLD,
    gapUnit: CHAT_HANDOFF_ARTIFACT_GAP_UNIT,
    sourceEntryCount,
    eligibleEntryCount,
    excludedEntryCounts,
    includedEntryCount,
    budgetOmittedEntryCount,
    abridgedEntryCount,
    gapCount,
    projectionTruncated,
    documentCodeUnits,
    document: raw.document,
  };
}

function parseExcludedEntryCounts(value: unknown): ChatHandoffArtifactExcludedEntryCount[] {
  if (!Array.isArray(value)) fail('excludedEntryCounts must be an array');
  const counts = value.map((item, index) => {
    const entry = record(item, `excludedEntryCounts[${index}]`);
    if (!isExclusionCategory(entry.category)) {
      return fail(`excludedEntryCounts[${index}].category is invalid`);
    }
    return {
      category: entry.category,
      count: positiveInteger(entry.count, `excludedEntryCounts[${index}].count`),
    };
  });
  const selected = new Set(counts.map((entry) => entry.category));
  const canonical = CHAT_HANDOFF_ARTIFACT_EXCLUSION_CATEGORIES
    .filter((category) => selected.has(category));
  if (
    canonical.length !== counts.length
    || canonical.some((category, index) => category !== counts[index].category)
  ) {
    fail('excludedEntryCounts must be unique and in canonical order');
  }
  return counts;
}

function isExclusionCategory(value: unknown): value is ChatHandoffArtifactExclusionCategory {
  return typeof value === 'string'
    && (CHAT_HANDOFF_ARTIFACT_EXCLUSION_CATEGORIES as readonly string[]).includes(value);
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = nonNegativeInteger(value, field);
  if (parsed === 0) fail(`${field} must be positive`);
  return parsed;
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
