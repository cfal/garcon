import { normalizeTagSlug, normalizeTags } from './tags.js';

export const CHAT_BOARD_MAX_COUNT = 50;
export const CHAT_BOARD_COLUMN_MAX_COUNT = 20;
export const CHAT_BOARD_COLUMN_TAG_MAX_COUNT = 32;
export const CHAT_BOARD_NAME_MAX_CODE_POINTS = 80;
export const CHAT_BOARD_TAG_MAX_CODE_POINTS = 64;
export const CHAT_BOARDS_FILE_MAX_BYTES = 4 * 1024 * 1024;

export type ChatBoardId = string;
export type ChatBoardColumnId = string;
export type ChatBoardMatchMode = 'all' | 'any';

export interface ChatBoardColumn {
  readonly id: ChatBoardColumnId;
  readonly name: string;
  readonly match: ChatBoardMatchMode;
  readonly tags: readonly string[];
}

export interface ChatBoard {
  readonly id: ChatBoardId;
  readonly name: string;
  readonly columns: readonly ChatBoardColumn[];
}

export interface ChatBoardCatalog {
  readonly revision: number;
  readonly boards: readonly ChatBoard[];
}

export interface CreateChatBoardRequest {
  readonly expectedRevision: number;
  readonly name: string;
}

export interface UpdateChatBoardRequest {
  readonly expectedRevision: number;
  readonly board: ChatBoard;
}

export interface DeleteChatBoardRequest {
  readonly expectedRevision: number;
  readonly boardId: ChatBoardId;
}

export interface ReorderChatBoardsRequest {
  readonly expectedRevision: number;
  readonly orderedBoardIds: readonly ChatBoardId[];
}

export interface ChatBoardMutationResponse {
  readonly success: true;
  readonly catalog: ChatBoardCatalog;
}

export interface CreateChatBoardResponse extends ChatBoardMutationResponse {
  readonly boardId: ChatBoardId;
}

export const CHAT_BOARD_INVALIDATION_REASONS = [
  'created',
  'updated',
  'removed',
  'reordered',
] as const;

export type ChatBoardInvalidationReason = (typeof CHAT_BOARD_INVALIDATION_REASONS)[number];

export const CHAT_BOARD_ERROR_CODES = {
  validationFailed: 'CHAT_BOARD_VALIDATION_FAILED',
  notFound: 'CHAT_BOARD_NOT_FOUND',
  revisionConflict: 'CHAT_BOARD_REVISION_CONFLICT',
  revisionExhausted: 'CHAT_BOARD_REVISION_EXHAUSTED',
  limitReached: 'CHAT_BOARD_LIMIT_REACHED',
  catalogSaveUnknown: 'CHAT_BOARD_CATALOG_SAVE_UNKNOWN',
  transitionInvalid: 'CHAT_BOARD_TRANSITION_INVALID',
  transitionChatArchived: 'CHAT_BOARD_TRANSITION_CHAT_ARCHIVED',
  transitionNoop: 'CHAT_BOARD_TRANSITION_NOOP',
} as const;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isChatBoardId(value: unknown): value is ChatBoardId {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value);
}

export const isChatBoardColumnId = isChatBoardId;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function canonicalName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().normalize('NFC');
  return name.length > 0 && [...name].length <= CHAT_BOARD_NAME_MAX_CODE_POINTS ? name : null;
}

function nameKey(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function canonicalRuleTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > CHAT_BOARD_COLUMN_TAG_MAX_COUNT) {
    return null;
  }
  if (!value.every((tag): tag is string => typeof tag === 'string')) return null;
  const tags = normalizeTags(value);
  if (
    tags.length !== value.length
    || tags.some((tag, index) => tag !== value[index])
    || tags.some((tag) => [...tag].length > CHAT_BOARD_TAG_MAX_CODE_POINTS)
  ) return null;
  return tags;
}

export function normalizeChatBoardColumn(value: unknown): ChatBoardColumn | null {
  const raw = record(value);
  if (!raw || !hasOnlyKeys(raw, ['id', 'name', 'match', 'tags'])) return null;
  if (!isChatBoardColumnId(raw.id) || (raw.match !== 'all' && raw.match !== 'any')) return null;
  const name = canonicalName(raw.name);
  const tags = canonicalRuleTags(raw.tags);
  return name && tags ? { id: raw.id, name, match: raw.match, tags } : null;
}

export function normalizeChatBoard(value: unknown): ChatBoard | null {
  const raw = record(value);
  if (!raw || !hasOnlyKeys(raw, ['id', 'name', 'columns']) || !isChatBoardId(raw.id)) return null;
  const name = canonicalName(raw.name);
  if (!name || !Array.isArray(raw.columns) || raw.columns.length > CHAT_BOARD_COLUMN_MAX_COUNT) {
    return null;
  }
  const columns = raw.columns.map(normalizeChatBoardColumn);
  if (columns.some((column) => column === null)) return null;
  const validColumns = columns as ChatBoardColumn[];
  if (
    new Set(validColumns.map((column) => column.id)).size !== validColumns.length
    || new Set(validColumns.map((column) => nameKey(column.name))).size !== validColumns.length
  ) return null;
  return { id: raw.id, name, columns: validColumns };
}

export function normalizeChatBoardCatalog(value: unknown): ChatBoardCatalog | null {
  const raw = record(value);
  if (
    !raw
    || !hasOnlyKeys(raw, ['revision', 'boards'])
    || !Number.isSafeInteger(raw.revision)
    || (raw.revision as number) < 0
    || !Array.isArray(raw.boards)
    || raw.boards.length > CHAT_BOARD_MAX_COUNT
  ) return null;
  const boards = raw.boards.map(normalizeChatBoard);
  if (boards.some((board) => board === null)) return null;
  const validBoards = boards as ChatBoard[];
  const boardIds = validBoards.map((board) => board.id);
  const columnIds = validBoards.flatMap((board) => board.columns.map((column) => column.id));
  if (
    new Set(boardIds).size !== boardIds.length
    || new Set(columnIds).size !== columnIds.length
    || new Set(validBoards.map((board) => nameKey(board.name))).size !== validBoards.length
  ) return null;
  return { revision: raw.revision as number, boards: validBoards };
}

export function normalizeChatBoardMutationResponse(value: unknown): ChatBoardMutationResponse | null {
  const raw = record(value);
  if (!raw || !hasOnlyKeys(raw, ['success', 'catalog']) || raw.success !== true) return null;
  const catalog = normalizeChatBoardCatalog(raw.catalog);
  return catalog ? { success: true, catalog } : null;
}

export function normalizeCreateChatBoardResponse(value: unknown): CreateChatBoardResponse | null {
  const raw = record(value);
  if (!raw || !hasOnlyKeys(raw, ['success', 'catalog', 'boardId']) || raw.success !== true) return null;
  const catalog = normalizeChatBoardCatalog(raw.catalog);
  return catalog && isChatBoardId(raw.boardId)
    ? { success: true, catalog, boardId: raw.boardId }
    : null;
}

export function chatMatchesBoardColumn(
  chatTags: readonly string[],
  column: Pick<ChatBoardColumn, 'match' | 'tags'>,
): boolean {
  return tagSetMatchesBoardColumn(new Set(chatTags), column);
}

export function tagSetMatchesBoardColumn(
  present: ReadonlySet<string>,
  column: Pick<ChatBoardColumn, 'match' | 'tags'>,
): boolean {
  if (column.tags.length === 0) return false;
  return column.match === 'all'
    ? column.tags.every((tag) => present.has(tag))
    : column.tags.some((tag) => present.has(tag));
}

export interface ChatTagTransitionPreview {
  readonly removedTags: readonly string[];
  readonly addedTags: readonly string[];
  readonly resultingTags: readonly string[];
}

export function calculateChatTagTransition(input: {
  readonly currentTags: readonly string[];
  readonly sourceTags: readonly string[];
  readonly appliedTargetTags: readonly string[];
}): ChatTagTransitionPreview {
  const current = normalizeTags(input.currentTags);
  const source = new Set(normalizeTags(input.sourceTags));
  const resultingTags = normalizeTags([
    ...current.filter((tag) => !source.has(tag)),
    ...normalizeTags(input.appliedTargetTags),
  ]);
  const before = new Set(current);
  const after = new Set(resultingTags);
  return {
    removedTags: current.filter((tag) => !after.has(tag)),
    addedTags: resultingTags.filter((tag) => !before.has(tag)),
    resultingTags,
  };
}

export function normalizeBoardTagInput(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeTagSlug(value);
  return normalized && [...normalized].length <= CHAT_BOARD_TAG_MAX_CODE_POINTS ? normalized : null;
}
