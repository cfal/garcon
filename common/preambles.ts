export const PREAMBLE_MAX_COUNT = 100;
export const PREAMBLE_TITLE_MAX_CODE_POINTS = 120;
export const PREAMBLE_CONTENT_MAX_LENGTH = 32_000;
export const PREAMBLE_COMBINED_MAX_LENGTH = 64_000;
export const PREAMBLE_PATH_RULE_MAX_COUNT = 32;
export const PREAMBLE_FILE_CONTEXT_SEPARATOR = '\n\nReferenced file contents from @file mentions:\n\n';

export const PREAMBLE_BOUNDARY_KINDS = [
  'new-chat',
  'fork',
  'continuation',
  'agent-switch',
] as const;

export type PreambleBoundaryKind = (typeof PREAMBLE_BOUNDARY_KINDS)[number];

export interface PendingPreambleBoundary {
  readonly kind: PreambleBoundaryKind;
  readonly ownershipEpoch: string;
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
  readonly title: string;
  readonly content: string;
  readonly scope: PreambleScope;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PreambleDefinitionInput {
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
} as const;

export type PreambleErrorCode = (typeof PREAMBLE_ERROR_CODES)[keyof typeof PREAMBLE_ERROR_CODES];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype
    ? value as Record<string, unknown>
    : null;
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
  if (!raw || !hasOnlyKeys(raw, ['kind', 'ownershipEpoch'])) return null;
  const ownershipEpoch = nonEmptyString(raw.ownershipEpoch);
  if (!isPreambleBoundaryKind(raw.kind) || !ownershipEpoch) return null;
  return { kind: raw.kind, ownershipEpoch };
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
  if (!raw || !hasOnlyKeys(raw, ['title', 'content', 'scope'])) return null;
  const title = normalizePreambleTitle(raw.title);
  const scope = normalizePreambleScope(raw.scope);
  if (
    !title
    || typeof raw.content !== 'string'
    || raw.content.trim().length === 0
    || raw.content.length > PREAMBLE_CONTENT_MAX_LENGTH
    || raw.content.includes(PREAMBLE_FILE_CONTEXT_SEPARATOR)
    || !scope
  ) return null;
  return { title, content: raw.content, scope };
}

export function normalizePreamble(value: unknown): Preamble | null {
  const raw = asRecord(value);
  if (!raw || !hasOnlyKeys(raw, ['id', 'title', 'content', 'scope', 'createdAt', 'updatedAt'])) {
    return null;
  }
  const id = nonEmptyString(raw.id);
  const definition = normalizePreambleDefinitionInput({
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
