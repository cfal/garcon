import { parseChatId } from './chat-id.js';

export const SNIPPET_MAX_COUNT = 100;
export const SNIPPET_SHORT_NAME_MAX_LENGTH = 64;
export const SNIPPET_TEMPLATE_MAX_LENGTH = 32_000;
export const SNIPPET_ARGUMENTS_MAX_LENGTH = 32_000;
export const SNIPPET_EXPANDED_MAX_LENGTH = 64_000;
export const SNIPPET_SHORT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SNIPPET_ARGUMENTS_TOKEN = '{{arguments}}';
export const SNIPPET_PROJECT_PATH_TOKEN = '{{project_path}}';
export const SNIPPET_CHAT_ID_TOKEN = '{{chat_id}}';

const SNIPPET_TEMPLATE_TOKEN_PATTERN = /\\?\{\{(?:arguments|project_path|chat_id)\}\}/g;

export type SnippetTemplateVariable = 'arguments' | 'project_path' | 'chat_id';

function snippetTemplateVariable(token: string): SnippetTemplateVariable {
  if (token === SNIPPET_ARGUMENTS_TOKEN) return 'arguments';
  if (token === SNIPPET_PROJECT_PATH_TOKEN) return 'project_path';
  return 'chat_id';
}

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
      variable: snippetTemplateVariable(token),
      escaped,
    };
  }
}

export function snippetTemplateTokenSignature(template: string): string[] {
  return Array.from(
    matchSnippetTemplateTokens(template),
    (match) => `${match.escaped ? 'escaped' : 'active'}:${match.variable}`,
  );
}

export function hasSameSnippetTemplateTokenSignature(first: string, second: string): boolean {
  const firstSignature = snippetTemplateTokenSignature(first);
  const secondSignature = snippetTemplateTokenSignature(second);
  return firstSignature.length === secondSignature.length
    && firstSignature.every((entry, index) => entry === secondSignature[index]);
}

function snippetTemplateUsesVariable(template: string, variable: SnippetTemplateVariable): boolean {
  for (const match of matchSnippetTemplateTokens(template)) {
    if (!match.escaped && match.variable === variable) return true;
  }
  return false;
}

export function snippetTemplateUsesArguments(template: string): boolean {
  return snippetTemplateUsesVariable(template, 'arguments');
}

export function snippetTemplateUsesProjectPath(template: string): boolean {
  return snippetTemplateUsesVariable(template, 'project_path');
}

export function snippetTemplateUsesChatId(template: string): boolean {
  return snippetTemplateUsesVariable(template, 'chat_id');
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

export type SnippetErrorCode = (typeof SNIPPET_ERROR_CODES)[keyof typeof SNIPPET_ERROR_CODES];

export interface Snippet {
  id: string;
  shortName: string;
  template: string;
  defaultArguments: string;
  createdAt: string;
  updatedAt: string;
}

export interface SnippetDefinitionInput {
  shortName: string;
  template: string;
  defaultArguments: string;
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
  // Registered chats resolve their authoritative project path from the server registry.
  { type: 'chat'; chatId: string } | { type: 'new-chat'; chatId: string; projectPath: string };

export type SnippetArgumentsInput = { type: 'default' } | { type: 'value'; value: string };

export interface ExpandSnippetRequest {
  shortName: string;
  arguments: SnippetArgumentsInput;
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

export const SNIPPETS_INVALIDATION_REASONS = ['created', 'updated', 'removed'] as const;

export type SnippetsInvalidationReason = (typeof SNIPPETS_INVALIDATION_REASONS)[number];

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
  return isPlainObject ? (value as Record<string, unknown>) : null;
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

export function isSnippetsInvalidationReason(value: unknown): value is SnippetsInvalidationReason {
  return (
    typeof value === 'string' &&
    (SNIPPETS_INVALIDATION_REASONS as readonly string[]).includes(value)
  );
}

export function normalizeSnippetDefinitionInput(value: unknown): SnippetDefinitionInput | null {
  const raw = asRecord(value);
  if (!raw || !isSnippetShortName(raw.shortName)) return null;
  if (
    typeof raw.template !== 'string' ||
    !raw.template.trim() ||
    raw.template.length > SNIPPET_TEMPLATE_MAX_LENGTH ||
    typeof raw.defaultArguments !== 'string' ||
    raw.defaultArguments.length > SNIPPET_ARGUMENTS_MAX_LENGTH ||
    (raw.defaultArguments.length > 0 && !snippetTemplateUsesArguments(raw.template))
  ) {
    return null;
  }
  return {
    shortName: raw.shortName,
    template: raw.template,
    defaultArguments: raw.defaultArguments,
  };
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

export function sortSnippetsByShortName(snippets: readonly Snippet[]): Snippet[] {
  return [...snippets].sort(
    (left, right) =>
      compareSnippetShortNames(left.shortName, right.shortName) ||
      left.id.localeCompare(right.id, 'en'),
  );
}

export function normalizeSnippetsSnapshot(value: unknown): SnippetsSnapshot | null {
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

export function normalizeSnippetsMutationResponse(value: unknown): SnippetsMutationResponse | null {
  const raw = asRecord(value);
  if (!raw || raw.success !== true) return null;
  const snapshot = normalizeSnippetsSnapshot(raw.snapshot);
  return snapshot ? { success: true, snapshot } : null;
}

export function normalizeSnippetArgumentsInput(value: unknown): SnippetArgumentsInput | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (raw.type === 'default') return { type: 'default' };
  if (
    raw.type === 'value' &&
    typeof raw.value === 'string' &&
    raw.value.length <= SNIPPET_ARGUMENTS_MAX_LENGTH
  ) {
    return { type: 'value', value: raw.value };
  }
  return null;
}

export function normalizeExpandSnippetRequest(value: unknown): ExpandSnippetRequest | null {
  const raw = asRecord(value);
  const argumentsInput = normalizeSnippetArgumentsInput(raw?.arguments);
  const context = asRecord(raw?.context);
  if (!raw || !isSnippetShortName(raw.shortName) || !argumentsInput || !context) {
    return null;
  }
  if (context.type === 'chat') {
    try {
      return {
        shortName: raw.shortName,
        arguments: argumentsInput,
        context: { type: 'chat', chatId: parseChatId(context.chatId) },
      };
    } catch {
      return null;
    }
  }
  if (context.type === 'new-chat') {
    const projectPath = requiredString(context.projectPath);
    if (!projectPath) return null;
    try {
      return {
        shortName: raw.shortName,
        arguments: argumentsInput,
        context: {
          type: 'new-chat',
          chatId: parseChatId(context.chatId),
          projectPath,
        },
      };
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeExpandSnippetResponse(value: unknown): ExpandSnippetResponse | null {
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
