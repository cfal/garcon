import { parseChatId } from './chat-id.js';

export const TRANSCRIPT_EXPORT_FORMATS = ['markdown', 'xml'] as const;
export type TranscriptExportFormat = (typeof TRANSCRIPT_EXPORT_FORMATS)[number];

export const TRANSCRIPT_EXPORT_CATEGORIES = [
  'tool-calls',
  'tool-results',
  'reasoning',
  'permissions',
  'diagnostics',
  'handoffs',
] as const;
export type TranscriptExportCategory = (typeof TRANSCRIPT_EXPORT_CATEGORIES)[number];

export const TRANSCRIPT_EXPORT_CATEGORY_ALIASES = {
  tools: ['tool-calls', 'tool-results'],
} as const satisfies Record<string, readonly TranscriptExportCategory[]>;

export interface TranscriptExportOmittedCount {
  readonly category: TranscriptExportCategory;
  readonly count: number;
}

export interface TranscriptExportResponse {
  readonly success: true;
  readonly chatId: string;
  readonly format: TranscriptExportFormat;
  readonly transcriptViewId: string;
  readonly lastOrdinal: number;
  readonly generatedAt: string;
  readonly entryCount: number;
  readonly totalEntryCount: number;
  readonly exclusions: readonly TranscriptExportCategory[];
  readonly omitted: readonly TranscriptExportOmittedCount[];
  readonly document: string;
}

export class TranscriptExportContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptExportContractError';
  }
}

const formatSet = new Set<string>(TRANSCRIPT_EXPORT_FORMATS);
const categorySet = new Set<string>(TRANSCRIPT_EXPORT_CATEGORIES);

export function isTranscriptExportFormat(value: unknown): value is TranscriptExportFormat {
  return typeof value === 'string' && formatSet.has(value);
}

export function isTranscriptExportCategory(value: unknown): value is TranscriptExportCategory {
  return typeof value === 'string' && categorySet.has(value);
}

export function canonicalTranscriptExportCategories(
  categories: Iterable<TranscriptExportCategory>,
): TranscriptExportCategory[] {
  const selected = new Set(categories);
  return TRANSCRIPT_EXPORT_CATEGORIES.filter((category) => selected.has(category));
}

export function parseTranscriptExportResponse(value: unknown): TranscriptExportResponse {
  const raw = record(value, 'transcript export response');
  if (raw.success !== true) fail('success must be true');
  let chatId: string;
  try {
    chatId = parseChatId(raw.chatId);
  } catch {
    return fail('chatId is invalid');
  }
  if (!isTranscriptExportFormat(raw.format)) fail('format is invalid');
  const transcriptViewId = nonEmptyString(raw.transcriptViewId, 'transcriptViewId');
  const lastOrdinal = nonNegativeInteger(raw.lastOrdinal, 'lastOrdinal');
  const generatedAt = canonicalTimestamp(raw.generatedAt, 'generatedAt');
  const entryCount = nonNegativeInteger(raw.entryCount, 'entryCount');
  const totalEntryCount = nonNegativeInteger(raw.totalEntryCount, 'totalEntryCount');
  if (entryCount > totalEntryCount) fail('entryCount exceeds totalEntryCount');
  const exclusions = categoryArray(raw.exclusions, 'exclusions');
  const omittedRaw = array(raw.omitted, 'omitted');
  const omitted = omittedRaw.map((item, index) => {
    const entry = record(item, `omitted[${index}]`);
    if (!isTranscriptExportCategory(entry.category)) {
      return fail(`omitted[${index}].category is invalid`);
    }
    return {
      category: entry.category,
      count: nonNegativeInteger(entry.count, `omitted[${index}].count`),
    };
  });
  if (
    omitted.length !== exclusions.length
    || omitted.some((entry, index) => entry.category !== exclusions[index])
    || omitted.reduce((sum, entry) => sum + entry.count, 0) !== totalEntryCount - entryCount
  ) {
    fail('omitted counts are inconsistent with exclusions and entry counts');
  }
  if (typeof raw.document !== 'string' || !raw.document.endsWith('\n')) {
    fail('document must be a string ending in a newline');
  }
  return {
    success: true,
    chatId,
    format: raw.format,
    transcriptViewId,
    lastOrdinal,
    generatedAt,
    entryCount,
    totalEntryCount,
    exclusions,
    omitted,
    document: raw.document,
  };
}

function categoryArray(value: unknown, field: string): TranscriptExportCategory[] {
  const items = array(value, field);
  if (!items.every(isTranscriptExportCategory)) fail(`${field} is invalid`);
  const categories = items as TranscriptExportCategory[];
  const canonical = canonicalTranscriptExportCategories(categories);
  if (
    canonical.length !== categories.length
    || canonical.some((category, index) => category !== categories[index])
  ) {
    fail(`${field} must be unique and in canonical order`);
  }
  return [...categories];
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

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function fail(message: string): never {
  throw new TranscriptExportContractError(message);
}
