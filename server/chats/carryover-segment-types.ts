import { isRecord } from '../../common/json.js';

export const CARRYOVER_SEGMENT_VERSION = 1 as const;
export const CARRYOVER_MESSAGE_SCHEMA_VERSION = 1 as const;

export type SeedSanitationOutcome = 'not-applicable' | 'stripped-exact' | 'absent';

export interface CarryOverPageDescriptor {
  readonly file: string;
  readonly firstSequence: number;
  readonly messageCount: number;
  readonly uncompressedBytes: number;
  readonly compressedBytes: number;
  readonly sha256: string;
}

export interface CarryOverSegmentIndex {
  readonly version: typeof CARRYOVER_SEGMENT_VERSION;
  readonly messageSchemaVersion: typeof CARRYOVER_MESSAGE_SCHEMA_VERSION;
  readonly id: string;
  readonly seedSanitation: SeedSanitationOutcome;
  readonly messageCount: number;
  readonly canonicalMessagesSha256: string;
  readonly pages: readonly CarryOverPageDescriptor[];
}

export function isCarryOverSegmentId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function parseCarryOverSegmentIndex(
  value: unknown,
  expectedId?: string,
): CarryOverSegmentIndex {
  if (!isRecord(value)) throw new Error('Carryover segment index must be an object');
  if (value.version !== CARRYOVER_SEGMENT_VERSION) {
    throw new Error('Unsupported carryover segment version');
  }
  if (value.messageSchemaVersion !== CARRYOVER_MESSAGE_SCHEMA_VERSION) {
    throw new Error('Unsupported carryover message schema version');
  }
  if (!isCarryOverSegmentId(value.id)) throw new Error('Invalid carryover segment ID');
  if (expectedId !== undefined && value.id !== expectedId) {
    throw new Error('Carryover segment directory and index IDs differ');
  }
  const messageCount = positiveSafeInteger(value.messageCount, 'message count');
  const canonicalMessagesSha256 = checksum(value.canonicalMessagesSha256, 'canonical digest');
  if (!Array.isArray(value.pages) || value.pages.length === 0) {
    throw new Error('Carryover segment has no pages');
  }
  const pages = value.pages.map((page, index) => parsePage(page, index));
  let expectedSequence = 0;
  for (const page of pages) {
    if (page.firstSequence !== expectedSequence) {
      throw new Error('Carryover page sequences are not contiguous');
    }
    expectedSequence += page.messageCount;
  }
  if (expectedSequence !== messageCount) {
    throw new Error('Carryover segment message count is inconsistent');
  }
  return Object.freeze({
    version: CARRYOVER_SEGMENT_VERSION,
    messageSchemaVersion: CARRYOVER_MESSAGE_SCHEMA_VERSION,
    id: value.id,
    seedSanitation: parseSeedSanitation(value.seedSanitation),
    messageCount,
    canonicalMessagesSha256,
    pages: Object.freeze(pages),
  });
}

function parsePage(value: unknown, index: number): CarryOverPageDescriptor {
  if (!isRecord(value)) throw new Error('Invalid carryover page descriptor');
  const file = `pages/${String(index).padStart(6, '0')}.json.br`;
  if (value.file !== file) throw new Error('Unsafe or noncanonical carryover page path');
  return Object.freeze({
    file,
    firstSequence: nonNegativeSafeInteger(value.firstSequence, 'page first sequence'),
    messageCount: positiveSafeInteger(value.messageCount, 'page message count'),
    uncompressedBytes: positiveSafeInteger(value.uncompressedBytes, 'page uncompressed bytes'),
    compressedBytes: positiveSafeInteger(value.compressedBytes, 'page compressed bytes'),
    sha256: checksum(value.sha256, 'page checksum'),
  });
}

function parseSeedSanitation(value: unknown): SeedSanitationOutcome {
  if (value === 'not-applicable' || value === 'stripped-exact' || value === 'absent') return value;
  throw new Error('Invalid carryover seed sanitation outcome');
}

function positiveSafeInteger(value: unknown, field: string): number {
  const parsed = nonNegativeSafeInteger(value, field);
  if (parsed === 0) throw new Error(`Invalid carryover ${field}`);
  return parsed;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid carryover ${field}`);
  }
  return Number(value);
}

function checksum(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Invalid carryover ${field}`);
  }
  return value;
}
