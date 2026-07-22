export const SNIPPET_MAX_COUNT = 100;
export const SNIPPET_SHORT_NAME_MAX_LENGTH = 64;
export const SNIPPET_TEMPLATE_MAX_LENGTH = 32_000;
export const SNIPPET_ARGUMENTS_MAX_LENGTH = 32_000;
export const SNIPPET_EXPANDED_MAX_LENGTH = 64_000;
export const SNIPPET_SHORT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SNIPPET_ARGUMENTS_TOKEN = '{{arguments}}';
export const SNIPPET_PROJECT_PATH_TOKEN = '{{project_path}}';

const SNIPPET_TEMPLATE_TOKEN_PATTERN = /\\?\{\{(?:arguments|project_path)\}\}/g;

export type SnippetTemplateVariable = 'arguments' | 'project_path';

export interface SnippetTemplateTokenMatch {
  index: number;
  raw: string;
  variable: SnippetTemplateVariable;
  escaped: boolean;
}

export function* matchSnippetTemplateTokens(
  template: string,
): Generator<SnippetTemplateTokenMatch> {
  for (const match of template.matchAll(SNIPPET_TEMPLATE_TOKEN_PATTERN)) {
    const raw = match[0];
    const escaped = raw.startsWith('\\');
    const token = escaped ? raw.slice(1) : raw;
    yield {
      index: match.index,
      raw,
      variable: token === SNIPPET_ARGUMENTS_TOKEN ? 'arguments' : 'project_path',
      escaped,
    };
  }
}

export function snippetTemplateUsesArguments(template: string): boolean {
  for (const match of matchSnippetTemplateTokens(template)) {
    if (!match.escaped && match.variable === 'arguments') return true;
  }
  return false;
}

export const SNIPPET_ERROR_CODES = {
  validationFailed: 'SNIPPET_VALIDATION_FAILED',
  notFound: 'SNIPPET_NOT_FOUND',
  nameConflict: 'SNIPPET_NAME_CONFLICT',
  revisionConflict: 'SNIPPET_REVISION_CONFLICT',
  revisionExhausted: 'SNIPPET_REVISION_EXHAUSTED',
  limitReached: 'SNIPPET_LIMIT_REACHED',
  expansionTooLong: 'SNIPPET_EXPANSION_TOO_LONG',
  chatNotFound: 'SNIPPET_CHAT_NOT_FOUND',
  projectPathRequired: 'SNIPPET_PROJECT_PATH_REQUIRED',
  projectPathOutsideBase: 'SNIPPET_PROJECT_PATH_OUTSIDE_BASE',
  projectPathNotFound: 'SNIPPET_PROJECT_PATH_NOT_FOUND',
  projectPathInaccessible: 'SNIPPET_PROJECT_PATH_INACCESSIBLE',
  projectPathNotDirectory: 'SNIPPET_PROJECT_PATH_NOT_DIRECTORY',
} as const;

export type SnippetErrorCode =
  (typeof SNIPPET_ERROR_CODES)[keyof typeof SNIPPET_ERROR_CODES];

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
  snippetUpdatedAt: string;
  shortName: string;
  contextProjectPath: string;
  expandedText: string;
}

export const SNIPPETS_INVALIDATION_REASONS = [
  'created',
  'updated',
  'removed',
] as const;

export type SnippetsInvalidationReason =
  (typeof SNIPPETS_INVALIDATION_REASONS)[number];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  const isPlainObject =
    prototype === null ||
    prototype === Object.prototype ||
    (Object.getPrototypeOf(prototype) === null &&
      typeof prototype.constructor === 'function' &&
      prototype.constructor.name === 'Object');
  return isPlainObject
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

const snippetShortNameCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

export function compareSnippetShortNames(left: string, right: string): number {
  return snippetShortNameCollator.compare(left, right);
}

export function sortSnippetsByShortName(
  snippets: readonly Snippet[],
): Snippet[] {
  return [...snippets].sort(
    (left, right) =>
      compareSnippetShortNames(left.shortName, right.shortName) ||
      left.id.localeCompare(right.id, 'en'),
  );
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
  return {
    revision: raw.revision as number,
    snippets: sortSnippetsByShortName(snippets),
  };
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
  const snippetUpdatedAt = isoTimestamp(raw?.snippetUpdatedAt);
  const contextProjectPath = requiredString(raw?.contextProjectPath);
  if (
    !raw ||
    raw.success !== true ||
    !snippetId ||
    !snippetUpdatedAt ||
    !isSnippetShortName(raw.shortName) ||
    !contextProjectPath ||
    typeof raw.expandedText !== 'string' ||
    raw.expandedText.length > SNIPPET_EXPANDED_MAX_LENGTH
  ) {
    return null;
  }
  return {
    success: true,
    snippetId,
    snippetUpdatedAt,
    shortName: raw.shortName,
    contextProjectPath,
    expandedText: raw.expandedText,
  };
}
