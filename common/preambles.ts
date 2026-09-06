import { CHAT_ID_TEMPLATE_TOKEN, CHAT_ID_TEMPLATE_VARIABLE, expandTemplate } from './template-tokens.js';

export const PREAMBLE_MAX_COUNT = 100;
export const PREAMBLE_TITLE_MAX_CODE_POINTS = 120;
export const PREAMBLE_CONTENT_MAX_LENGTH = 32_000;
export const PREAMBLE_COMBINED_MAX_LENGTH = 64_000;
export const PREAMBLE_PATH_RULE_MAX_COUNT = 32;
export const PREAMBLE_FILE_CONTEXT_SEPARATOR = '\n\nReferenced file contents from @file mentions:\n\n';
export const PREAMBLE_CHAT_ID_TOKEN = CHAT_ID_TEMPLATE_TOKEN;
// Lifetime bounds cover active plus retired IDs; tombstones are never pruned.
export const PREAMBLE_ID_LIFETIME_MAX_COUNT = 100_000;
export const PREAMBLES_FILE_MAX_BYTES = 64 * 1024 * 1024;

const PREAMBLE_TEMPLATE_VARIABLES = [CHAT_ID_TEMPLATE_VARIABLE] as const;

export const PREAMBLE_BOUNDARY_KINDS = [
  'new-chat',
  'fork',
  'continuation',
  'agent-switch',
  'selection-change',
] as const;

export type PreambleBoundaryKind = (typeof PREAMBLE_BOUNDARY_KINDS)[number];

export type PendingPreambleBoundary =
  | {
      readonly kind: Exclude<PreambleBoundaryKind, 'selection-change'>;
      readonly ownershipEpoch: string;
    }
  | {
      readonly kind: 'selection-change';
      readonly ownershipEpoch: string;
      readonly selectionRevision: number;
    };

// A selection-change boundary is repeatable within one ownership epoch, so its
// full identity includes the selection revision it was armed for.
export function samePreambleBoundary(
  left: PendingPreambleBoundary,
  right: PendingPreambleBoundary,
): boolean {
  if (left.kind !== right.kind || left.ownershipEpoch !== right.ownershipEpoch) {
    return false;
  }
  if (left.kind !== 'selection-change') return true;
  return right.kind === 'selection-change'
    && left.selectionRevision === right.selectionRevision;
}

export type PreambleId = string;

const PREAMBLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isPreambleId(value: unknown): value is PreambleId {
  return typeof value === 'string' && PREAMBLE_ID_PATTERN.test(value);
}

export interface ChatPreambleSelection {
  readonly revision: number;
  readonly orderedPreambleIds: readonly PreambleId[];
}

export type PreambleSelectionUnavailableReason =
  | 'missing'
  | 'disabled'
  | 'out-of-scope';

export interface PreambleSelectionReference {
  readonly id: PreambleId;
  readonly title: string;
}

export interface UnavailablePreambleSelectionReference {
  readonly id: PreambleId;
  readonly reason: PreambleSelectionUnavailableReason;
}

export interface PreambleSelectionProjection {
  readonly catalogRevision: number;
  readonly eligiblePreambles: readonly PreambleSelectionReference[];
  readonly unavailable: readonly UnavailablePreambleSelectionReference[];
}

export const PREAMBLE_SELECTION_UNAVAILABLE_REASONS = [
  'missing',
  'disabled',
  'out-of-scope',
] as const;

export function isPreambleSelectionUnavailableReason(
  value: unknown,
): value is PreambleSelectionUnavailableReason {
  return typeof value === 'string'
    && (PREAMBLE_SELECTION_UNAVAILABLE_REASONS as readonly string[]).includes(value);
}

export interface PreambleProjectPathRule {
  readonly projectPath: string;
  readonly includeNested: boolean;
}

export type PreambleScope =
  | { readonly type: 'global' }
  | {
      readonly type: 'project-paths';
      readonly rules: readonly PreambleProjectPathRule[];
    };

export interface Preamble {
  readonly id: string;
  readonly enabled: boolean;
  readonly title: string;
  readonly content: string;
  readonly scope: PreambleScope;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PreambleDefinitionInput {
  readonly enabled: boolean;
  readonly title: string;
  readonly content: string;
  readonly scope: PreambleScope;
}

export interface PreamblesSnapshot {
  readonly revision: number;
  readonly preambles: readonly Preamble[];
}

export interface CreatePreambleRequest {
  readonly expectedRevision: number;
  readonly preamble: PreambleDefinitionInput;
}

export interface UpdatePreambleRequest extends CreatePreambleRequest {
  readonly id: string;
}

export interface RemovePreambleRequest {
  readonly expectedRevision: number;
  readonly id: string;
}

export interface ReorderPreamblesRequest {
  readonly expectedRevision: number;
  readonly orderedPreambleIds: readonly string[];
}

export interface PreamblesMutationResponse {
  readonly success: true;
  readonly snapshot: PreamblesSnapshot;
}

export function normalizePreamblesMutationResponse(
  value: unknown,
): PreamblesMutationResponse | null {
  const raw = asRecord(value);
  if (!raw || !hasOnlyKeys(raw, ['success', 'snapshot']) || raw.success !== true) return null;
  const snapshot = normalizePreamblesSnapshot(raw.snapshot);
  return snapshot ? { success: true, snapshot } : null;
}

export const PREAMBLES_INVALIDATION_REASONS = [
  'created',
  'updated',
  'removed',
  'reordered',
] as const;

export type PreamblesInvalidationReason = (typeof PREAMBLES_INVALIDATION_REASONS)[number];

export const PREAMBLE_ERROR_CODES = {
  validationFailed: 'PREAMBLE_VALIDATION_FAILED',
  notFound: 'PREAMBLE_NOT_FOUND',
  revisionConflict: 'PREAMBLE_REVISION_CONFLICT',
  revisionExhausted: 'PREAMBLE_REVISION_EXHAUSTED',
  limitReached: 'PREAMBLE_LIMIT_REACHED',
  combinedLimitExceeded: 'PREAMBLE_COMBINED_LIMIT_EXCEEDED',
  projectPathOutsideBase: 'PREAMBLE_PROJECT_PATH_OUTSIDE_BASE',
  projectPathNotFound: 'PREAMBLE_PROJECT_PATH_NOT_FOUND',
  projectPathInaccessible: 'PREAMBLE_PROJECT_PATH_INACCESSIBLE',
  projectPathNotDirectory: 'PREAMBLE_PROJECT_PATH_NOT_DIRECTORY',
  envelopeMismatch: 'PREAMBLE_ENVELOPE_MISMATCH',
  slashCommandBlocked: 'PREAMBLE_SLASH_COMMAND_BLOCKED',
  idCollision: 'PREAMBLE_ID_COLLISION',
  idLifetimeLimitReached: 'PREAMBLE_ID_LIFETIME_LIMIT_REACHED',
  catalogSaveUnknown: 'PREAMBLE_CATALOG_SAVE_UNKNOWN',
  selectionRevisionConflict: 'PREAMBLE_SELECTION_REVISION_CONFLICT',
  selectionCompositionInvalid: 'PREAMBLE_SELECTION_COMPOSITION_INVALID',
  selectionNoticeFailed: 'PREAMBLE_SELECTION_NOTICE_FAILED',
  selectionSaveUnknown: 'PREAMBLE_SELECTION_SAVE_UNKNOWN',
} as const;

export type PreambleErrorCode = (typeof PREAMBLE_ERROR_CODES)[keyof typeof PREAMBLE_ERROR_CODES];

export function renderPreambleContent(content: string, chatId: string): string {
  return expandTemplate(
    content,
    PREAMBLE_TEMPLATE_VARIABLES,
    { chat_id: chatId },
    PREAMBLE_COMBINED_MAX_LENGTH,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function isPreambleBoundaryKind(value: unknown): value is PreambleBoundaryKind {
  return typeof value === 'string'
    && (PREAMBLE_BOUNDARY_KINDS as readonly string[]).includes(value);
}

export function normalizePendingPreambleBoundary(value: unknown): PendingPreambleBoundary | null {
  const raw = asRecord(value);
  if (!raw || !isPreambleBoundaryKind(raw.kind)) return null;
  const ownershipEpoch = nonEmptyString(raw.ownershipEpoch);
  if (!ownershipEpoch) return null;
  if (raw.kind === 'selection-change') {
    if (!hasOnlyKeys(raw, ['kind', 'ownershipEpoch', 'selectionRevision'])) return null;
    if (!Number.isSafeInteger(raw.selectionRevision) || (raw.selectionRevision as number) < 0) {
      return null;
    }
    return {
      kind: 'selection-change',
      ownershipEpoch,
      selectionRevision: raw.selectionRevision as number,
    };
  }
  if (!hasOnlyKeys(raw, ['kind', 'ownershipEpoch'])) return null;
  return { kind: raw.kind, ownershipEpoch };
}

// Persistence parsing performs no catalog lookup: missing IDs stay saved, order is
// preserved, and nothing is truncated, deduplicated, or sorted.
export function normalizeChatPreambleSelection(value: unknown): ChatPreambleSelection | null {
  const raw = asRecord(value);
  if (
    !raw
    || !hasOnlyKeys(raw, ['revision', 'orderedPreambleIds'])
    || !Number.isSafeInteger(raw.revision)
    || (raw.revision as number) < 0
    || !Array.isArray(raw.orderedPreambleIds)
    || raw.orderedPreambleIds.length > PREAMBLE_MAX_COUNT
  ) return null;
  const orderedPreambleIds: PreambleId[] = [];
  const seen = new Set<PreambleId>();
  for (const id of raw.orderedPreambleIds) {
    if (!isPreambleId(id) || seen.has(id)) return null;
    seen.add(id);
    orderedPreambleIds.push(id);
  }
  return { revision: raw.revision as number, orderedPreambleIds };
}

export function normalizePreambleSelectionReference(
  value: unknown,
): PreambleSelectionReference | null {
  const raw = asRecord(value);
  if (!raw || !hasOnlyKeys(raw, ['id', 'title'])) return null;
  if (!isPreambleId(raw.id)) return null;
  const title = normalizePreambleTitle(raw.title);
  return title ? { id: raw.id, title } : null;
}

export function normalizeUnavailablePreambleSelectionReference(
  value: unknown,
): UnavailablePreambleSelectionReference | null {
  const raw = asRecord(value);
  if (
    !raw
    || !hasOnlyKeys(raw, ['id', 'reason'])
    || !isPreambleId(raw.id)
    || !isPreambleSelectionUnavailableReason(raw.reason)
  ) return null;
  return { id: raw.id, reason: raw.reason };
}

export function normalizePreambleSelectionProjection(
  value: unknown,
): PreambleSelectionProjection | null {
  const raw = asRecord(value);
  if (
    !raw
    || !hasOnlyKeys(raw, ['catalogRevision', 'eligiblePreambles', 'unavailable'])
    || !Number.isSafeInteger(raw.catalogRevision)
    || (raw.catalogRevision as number) < 0
    || !Array.isArray(raw.eligiblePreambles)
    || raw.eligiblePreambles.length > PREAMBLE_MAX_COUNT
    || !Array.isArray(raw.unavailable)
    || raw.unavailable.length > PREAMBLE_MAX_COUNT
  ) return null;
  const eligiblePreambles: PreambleSelectionReference[] = [];
  const eligibleIds = new Set<PreambleId>();
  for (const item of raw.eligiblePreambles) {
    const reference = normalizePreambleSelectionReference(item);
    if (!reference || eligibleIds.has(reference.id)) return null;
    eligibleIds.add(reference.id);
    eligiblePreambles.push(reference);
  }
  const unavailable: UnavailablePreambleSelectionReference[] = [];
  const unavailableIds = new Set<PreambleId>();
  for (const item of raw.unavailable) {
    const reference = normalizeUnavailablePreambleSelectionReference(item);
    if (!reference || unavailableIds.has(reference.id) || eligibleIds.has(reference.id)) return null;
    unavailableIds.add(reference.id);
    unavailable.push(reference);
  }
  return { catalogRevision: raw.catalogRevision as number, eligiblePreambles, unavailable };
}

export function isPreamblesInvalidationReason(
  value: unknown,
): value is PreamblesInvalidationReason {
  return typeof value === 'string'
    && (PREAMBLES_INVALIDATION_REASONS as readonly string[]).includes(value);
}

export function normalizePreambleTitle(value: unknown): string | null {
  const title = nonEmptyString(value);
  if (!title || /[\r\n]/u.test(title)) return null;
  return Array.from(title).length <= PREAMBLE_TITLE_MAX_CODE_POINTS ? title : null;
}

export function normalizePreambleScope(value: unknown): PreambleScope | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (raw.type === 'global') {
    return hasOnlyKeys(raw, ['type']) ? { type: 'global' } : null;
  }
  if (
    raw.type !== 'project-paths'
    || !hasOnlyKeys(raw, ['type', 'rules'])
    || !Array.isArray(raw.rules)
    || raw.rules.length < 1
    || raw.rules.length > PREAMBLE_PATH_RULE_MAX_COUNT
  ) return null;
  const rules: PreambleProjectPathRule[] = [];
  const paths = new Set<string>();
  for (const valueRule of raw.rules) {
    const rule = asRecord(valueRule);
    if (!rule || !hasOnlyKeys(rule, ['projectPath', 'includeNested'])) return null;
    const projectPath = nonEmptyString(rule.projectPath);
    if (!projectPath || typeof rule.includeNested !== 'boolean' || paths.has(projectPath)) {
      return null;
    }
    paths.add(projectPath);
    rules.push({ projectPath, includeNested: rule.includeNested });
  }
  return { type: 'project-paths', rules };
}

export function normalizePreambleDefinitionInput(value: unknown): PreambleDefinitionInput | null {
  const raw = asRecord(value);
  if (!raw || !hasOnlyKeys(raw, ['enabled', 'title', 'content', 'scope'])) return null;
  const title = normalizePreambleTitle(raw.title);
  const scope = normalizePreambleScope(raw.scope);
  if (
    typeof raw.enabled !== 'boolean'
    || !title
    || typeof raw.content !== 'string'
    || raw.content.trim().length === 0
    || raw.content.length > PREAMBLE_CONTENT_MAX_LENGTH
    || raw.content.includes(PREAMBLE_FILE_CONTEXT_SEPARATOR)
    || !scope
  ) return null;
  return { enabled: raw.enabled, title, content: raw.content, scope };
}

export function normalizePreamble(value: unknown): Preamble | null {
  const raw = asRecord(value);
  if (!raw || !hasOnlyKeys(raw, [
    'id',
    'enabled',
    'title',
    'content',
    'scope',
    'createdAt',
    'updatedAt',
  ])) {
    return null;
  }
  const id = isPreambleId(raw.id) ? raw.id : null;
  const definition = normalizePreambleDefinitionInput({
    enabled: raw.enabled,
    title: raw.title,
    content: raw.content,
    scope: raw.scope,
  });
  const createdAt = timestamp(raw.createdAt);
  const updatedAt = timestamp(raw.updatedAt);
  return id && definition && createdAt && updatedAt
    ? { id, ...definition, createdAt, updatedAt }
    : null;
}

export function normalizePreamblesSnapshot(value: unknown): PreamblesSnapshot | null {
  const raw = asRecord(value);
  if (
    !raw
    || !hasOnlyKeys(raw, ['revision', 'preambles'])
    || !Number.isSafeInteger(raw.revision)
    || (raw.revision as number) < 0
    || !Array.isArray(raw.preambles)
    || raw.preambles.length > PREAMBLE_MAX_COUNT
  ) return null;
  const preambles: Preamble[] = [];
  const ids = new Set<string>();
  for (const item of raw.preambles) {
    const preamble = normalizePreamble(item);
    if (!preamble || ids.has(preamble.id)) return null;
    ids.add(preamble.id);
    preambles.push(preamble);
  }
  return { revision: raw.revision as number, preambles };
}
