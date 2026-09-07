import { isRecord } from '../../common/json.js';

export const CARRYOVER_NODE_VERSION = 1 as const;

export interface CarryOverSourceDescriptor {
  readonly agentId: string;
  readonly model: string;
  readonly nativeSessionId: string | null;
  readonly nativeRevision: string;
}

export interface CarryOverTargetDescriptor {
  readonly agentId: string;
  readonly model: string;
}

export type SeedSanitationOutcome = 'not-applicable' | 'stripped-exact' | 'absent';

export interface CarryOverBoundaryDescriptor {
  readonly kind: 'handoff';
  readonly targetAtCapture: CarryOverTargetDescriptor;
}

export interface CarryOverPageDescriptor {
  readonly file: string;
  readonly firstSequence: number;
  readonly messageCount: number;
  readonly uncompressedBytes: number;
  readonly compressedBytes: number;
  readonly sha256: string;
}

export interface MaterializedCarryOverNode {
  readonly version: typeof CARRYOVER_NODE_VERSION;
  readonly kind: 'materialized';
  readonly id: string;
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly source: CarryOverSourceDescriptor;
  readonly boundary: CarryOverBoundaryDescriptor | null;
  readonly seedSanitation: SeedSanitationOutcome;
  readonly messageCount: number;
  readonly pages: readonly CarryOverPageDescriptor[];
}

export interface PrefixCarryOverNode {
  readonly version: typeof CARRYOVER_NODE_VERSION;
  readonly kind: 'prefix';
  readonly id: string;
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly sourceNodeId: string;
  readonly messageCount: number;
  readonly source: CarryOverSourceDescriptor;
}

export type CarryOverNode = MaterializedCarryOverNode | PrefixCarryOverNode;

export function isCarryOverNodeId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function parseCarryOverNode(value: unknown, expectedId?: string): CarryOverNode {
  if (!isRecord(value)) throw new Error('Carryover node manifest must be an object');
  if (value.version !== CARRYOVER_NODE_VERSION) throw new Error('Unsupported carryover node version');
  if (value.kind !== 'materialized' && value.kind !== 'prefix') {
    throw new Error('Unsupported carryover node kind');
  }
  if (!isCarryOverNodeId(value.id)) throw new Error('Invalid carryover node ID');
  const id = value.id.toLowerCase();
  if (expectedId && id !== expectedId.toLowerCase()) {
    throw new Error('Carryover node directory and manifest IDs differ');
  }
  const parentId = nullableNodeId(value.parentId, 'parent');
  if (parentId === id) throw new Error('Carryover node cannot be its own parent');
  const createdAt = requiredTimestamp(value.createdAt);
  const source = parseSource(value.source);
  const messageCount = nonNegativeSafeInteger(value.messageCount, 'message count');

  if (value.kind === 'prefix') {
    if (!isCarryOverNodeId(value.sourceNodeId)) throw new Error('Invalid carryover prefix source ID');
    const sourceNodeId = value.sourceNodeId.toLowerCase();
    if (sourceNodeId === id) throw new Error('Carryover prefix cannot reference itself');
    if (messageCount < 1) throw new Error('Carryover prefix must contain at least one message');
    if ('pages' in value || 'boundary' in value || 'seedSanitation' in value) {
      throw new Error('Carryover prefix contains materialized fields');
    }
    return {
      version: CARRYOVER_NODE_VERSION,
      kind: 'prefix',
      id,
      parentId,
      createdAt,
      sourceNodeId,
      messageCount,
      source,
    };
  }

  const boundary = parseBoundary(value.boundary);
  if (messageCount === 0 && boundary === null) {
    throw new Error('Materialized carryover node must contain messages or a boundary');
  }
  if (!Array.isArray(value.pages) || (messageCount > 0 && value.pages.length === 0)) {
    throw new Error('Materialized carryover node has no pages');
  }
  if (messageCount === 0 && value.pages.length !== 0) {
    throw new Error('Boundary-only carryover node must not contain pages');
  }
  const pages = value.pages.map((page, index) => parsePage(page, index));
  let expectedSequence = 0;
  for (const page of pages) {
    if (page.firstSequence !== expectedSequence) {
      throw new Error('Carryover page sequences are not contiguous');
    }
    expectedSequence += page.messageCount;
  }
  if (expectedSequence !== messageCount) throw new Error('Carryover node message count is inconsistent');
  return {
    version: CARRYOVER_NODE_VERSION,
    kind: 'materialized',
    id,
    parentId,
    createdAt,
    source,
    boundary,
    seedSanitation: parseSeedSanitation(value.seedSanitation),
    messageCount,
    pages,
  };
}

function parseSource(value: unknown): CarryOverSourceDescriptor {
  if (!isRecord(value)) throw new Error('Invalid carryover source descriptor');
  return {
    agentId: nonEmptyString(value.agentId, 'source agent'),
    model: stringValue(value.model, 'source model'),
    nativeSessionId: value.nativeSessionId === null
      ? null
      : nonEmptyString(value.nativeSessionId, 'native session ID'),
    nativeRevision: nonEmptyString(value.nativeRevision, 'native revision'),
  };
}

function parseBoundary(value: unknown): CarryOverBoundaryDescriptor | null {
  if (value === null) return null;
  if (!isRecord(value) || value.kind !== 'handoff' || !isRecord(value.targetAtCapture)) {
    throw new Error('Invalid carryover boundary descriptor');
  }
  return {
    kind: 'handoff',
    targetAtCapture: {
      agentId: nonEmptyString(value.targetAtCapture.agentId, 'boundary target agent'),
      model: stringValue(value.targetAtCapture.model, 'boundary target model'),
    },
  };
}

function parsePage(value: unknown, index: number): CarryOverPageDescriptor {
  if (!isRecord(value)) throw new Error('Invalid carryover page descriptor');
  const expectedFile = `pages/${String(index).padStart(6, '0')}.json.br`;
  if (value.file !== expectedFile) throw new Error('Unsafe or noncanonical carryover page path');
  const messageCount = positiveSafeInteger(value.messageCount, 'page message count');
  const sha256 = nonEmptyString(value.sha256, 'page checksum');
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid carryover page checksum');
  return {
    file: expectedFile,
    firstSequence: nonNegativeSafeInteger(value.firstSequence, 'page first sequence'),
    messageCount,
    uncompressedBytes: positiveSafeInteger(value.uncompressedBytes, 'page uncompressed bytes'),
    compressedBytes: positiveSafeInteger(value.compressedBytes, 'page compressed bytes'),
    sha256,
  };
}

function parseSeedSanitation(value: unknown): SeedSanitationOutcome {
  if (value === 'not-applicable' || value === 'stripped-exact' || value === 'absent') return value;
  throw new Error('Invalid carryover seed sanitation outcome');
}

function nullableNodeId(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (!isCarryOverNodeId(value)) throw new Error(`Invalid carryover ${field} ID`);
  return value.toLowerCase();
}

function requiredTimestamp(value: unknown): string {
  const timestamp = nonEmptyString(value, 'created timestamp');
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid carryover creation timestamp');
  return timestamp;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid carryover ${field}`);
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid carryover ${field}`);
  return value;
}

function positiveSafeInteger(value: unknown, field: string): number {
  const parsed = nonNegativeSafeInteger(value, field);
  if (parsed < 1) throw new Error(`Invalid carryover ${field}`);
  return parsed;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid carryover ${field}`);
  return Number(value);
}
