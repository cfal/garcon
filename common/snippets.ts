export const SNIPPET_MAX_COUNT = 100;
export const SNIPPET_SHORT_NAME_MAX_LENGTH = 64;
export const SNIPPET_TEMPLATE_MAX_LENGTH = 32_000;
export const SNIPPET_ARGUMENTS_MAX_LENGTH = 32_000;
export const SNIPPET_EXPANDED_MAX_LENGTH = 64_000;
export const SNIPPET_SHORT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface Snippet {
  id: string;
  shortName: string;
  template: string;
  createdAt: string;
  updatedAt: string;
}

export interface SnippetDefinitionInput {
  shortName: string;
  template: string;
}

export interface SnippetsSnapshot {
  revision: number;
  snippets: Snippet[];
}

export interface CreateSnippetRequest {
  expectedRevision: number;
  snippet: SnippetDefinitionInput;
}

export interface UpdateSnippetRequest extends CreateSnippetRequest {
  id: string;
}

export interface RemoveSnippetRequest {
  expectedRevision: number;
  id: string;
}

export interface ReorderSnippetsRequest {
  expectedRevision: number;
  orderedSnippetIds: string[];
}

export interface SnippetsMutationResponse {
  success: true;
  snapshot: SnippetsSnapshot;
}

export type SnippetExpansionContext =
  | { type: 'chat'; chatId: string }
  | { type: 'project'; projectPath: string };

export interface ExpandSnippetRequest {
  shortName: string;
  arguments: string;
  context: SnippetExpansionContext;
}

export interface ExpandSnippetResponse {
  success: true;
  snippetId: string;
  shortName: string;
  expandedText: string;
}

export const SNIPPETS_INVALIDATION_REASONS = [
  'created',
  'updated',
  'removed',
  'reordered',
] as const;

export type SnippetsInvalidationReason =
  (typeof SNIPPETS_INVALIDATION_REASONS)[number];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function isSnippetShortName(value: unknown): value is string {
  return typeof value === 'string' && SNIPPET_SHORT_NAME_PATTERN.test(value);
}

export function isSnippetsInvalidationReason(
  value: unknown,
): value is SnippetsInvalidationReason {
  return (
    typeof value === 'string' &&
    (SNIPPETS_INVALIDATION_REASONS as readonly string[]).includes(value)
  );
}

export function normalizeSnippetDefinitionInput(
  value: unknown,
): SnippetDefinitionInput | null {
  const raw = asRecord(value);
  if (!raw || !isSnippetShortName(raw.shortName)) return null;
  if (
    typeof raw.template !== 'string' ||
    !raw.template.trim() ||
    raw.template.length > SNIPPET_TEMPLATE_MAX_LENGTH
  ) {
    return null;
  }
  return { shortName: raw.shortName, template: raw.template };
}

export function normalizeSnippet(value: unknown): Snippet | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const id = requiredString(raw.id);
  const definition = normalizeSnippetDefinitionInput(raw);
  const createdAt = isoTimestamp(raw.createdAt);
  const updatedAt = isoTimestamp(raw.updatedAt);
  if (!id || !definition || !createdAt || !updatedAt) return null;
  return { id, ...definition, createdAt, updatedAt };
}

export function normalizeSnippetsSnapshot(
  value: unknown,
): SnippetsSnapshot | null {
  const raw = asRecord(value);
  if (
    !raw ||
    !Number.isSafeInteger(raw.revision) ||
    (raw.revision as number) < 0 ||
    !Array.isArray(raw.snippets) ||
    raw.snippets.length > SNIPPET_MAX_COUNT
  ) {
    return null;
  }
  const snippets = raw.snippets
    .map(normalizeSnippet)
    .filter((snippet): snippet is Snippet => Boolean(snippet));
  if (snippets.length !== raw.snippets.length) return null;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const snippet of snippets) {
    if (ids.has(snippet.id) || names.has(snippet.shortName)) return null;
    ids.add(snippet.id);
    names.add(snippet.shortName);
  }
  return { revision: raw.revision as number, snippets };
}

export function normalizeSnippetsMutationResponse(
  value: unknown,
): SnippetsMutationResponse | null {
  const raw = asRecord(value);
  if (!raw || raw.success !== true) return null;
  const snapshot = normalizeSnippetsSnapshot(raw.snapshot);
  return snapshot ? { success: true, snapshot } : null;
}

export function normalizeExpandSnippetRequest(
  value: unknown,
): ExpandSnippetRequest | null {
  const raw = asRecord(value);
  const context = asRecord(raw?.context);
  if (
    !raw ||
    !isSnippetShortName(raw.shortName) ||
    typeof raw.arguments !== 'string' ||
    raw.arguments.length > SNIPPET_ARGUMENTS_MAX_LENGTH ||
    !context
  ) {
    return null;
  }
  if (context.type === 'chat') {
    const chatId = requiredString(context.chatId);
    return chatId
      ? {
          shortName: raw.shortName,
          arguments: raw.arguments,
          context: { type: 'chat', chatId },
        }
      : null;
  }
  if (context.type === 'project') {
    const projectPath = requiredString(context.projectPath);
    return projectPath
      ? {
          shortName: raw.shortName,
          arguments: raw.arguments,
          context: { type: 'project', projectPath },
        }
      : null;
  }
  return null;
}

export function normalizeExpandSnippetResponse(
  value: unknown,
): ExpandSnippetResponse | null {
  const raw = asRecord(value);
  const snippetId = requiredString(raw?.snippetId);
  if (
    !raw ||
    raw.success !== true ||
    !snippetId ||
    !isSnippetShortName(raw.shortName) ||
    typeof raw.expandedText !== 'string' ||
    raw.expandedText.length > SNIPPET_EXPANDED_MAX_LENGTH
  ) {
    return null;
  }
  return {
    success: true,
    snippetId,
    shortName: raw.shortName,
    expandedText: raw.expandedText,
  };
}
