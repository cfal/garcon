import {
  PERSISTED_CHAT_ORDER_GROUPS,
  type PersistedChatOrderGroup,
} from './chat-order-contracts.js';
import { parseChatId } from './chat-id.js';

export type ChatFilterOrGroup = string[];

export interface ChatOrderGroupFilter {
  group: PersistedChatOrderGroup;
  negated: boolean;
}

export interface ChatFilterSpec {
  textTokens: string[];
  titles: ChatFilterOrGroup[];
  tags: ChatFilterOrGroup[];
  agents: string[];
  models: string[];
  status?: 'active' | 'unread';
  orderGroup?: ChatOrderGroupFilter;
  project: string[];
  ids?: ChatFilterOrGroup[];
  parents?: ChatFilterOrGroup[];
  createdBefore?: string[];
  createdAfter?: string[];
  updatedBefore?: string[];
  updatedAfter?: string[];
}

export interface ChatFilterParseResult {
  readonly spec: ChatFilterSpec;
  readonly invalidTokens: readonly string[];
}

export interface ChatFilterTarget {
  readonly id: string;
  readonly parentChat: { readonly chatId: string } | null;
  readonly title: string;
  readonly projectPath: string;
  readonly agentId: string;
  readonly model: string | null;
  readonly tags: readonly string[];
  readonly isProcessing: boolean;
  readonly isUnread: boolean;
  readonly isPinned: boolean;
  readonly isArchived: boolean;
  readonly createdAt: string | null;
  readonly lastActivityAt: string | null;
  readonly firstMessage?: string;
  readonly lastMessage?: string;
}

export function emptyFilterSpec(): ChatFilterSpec {
  return { textTokens: [], titles: [], tags: [], agents: [], models: [], project: [] };
}

export function isEmptyFilter(spec: ChatFilterSpec): boolean {
  return spec.textTokens.length === 0
    && spec.titles.length === 0
    && spec.tags.length === 0
    && spec.agents.length === 0
    && spec.models.length === 0
    && spec.status === undefined
    && spec.orderGroup === undefined
    && spec.project.length === 0
    && (spec.ids?.length ?? 0) === 0
    && (spec.parents?.length ?? 0) === 0
    && (spec.createdBefore?.length ?? 0) === 0
    && (spec.createdAfter?.length ?? 0) === 0
    && (spec.updatedBefore?.length ?? 0) === 0
    && (spec.updatedAfter?.length ?? 0) === 0;
}

export function parseChatFilterQuery(query: string): ChatFilterParseResult {
  const spec = emptyFilterSpec();
  const invalidTokens: string[] = [];
  const raw = query.trim();
  if (!raw) return { spec, invalidTokens };

  for (const token of tokenizeChatFilter(raw)) {
    const lower = token.toLowerCase();
    if (lower.startsWith('status:')) {
      const value = token.slice(7).trim().toLowerCase();
      if (value === 'active' || value === 'unread') spec.status = value;
      else invalidTokens.push(token);
      continue;
    }
    if (lower.startsWith('is:')) {
      const value = token.slice(3).trim().toLowerCase();
      const negated = value.startsWith('!');
      const rawGroup = negated ? value.slice(1) : value;
      const group = PERSISTED_CHAT_ORDER_GROUPS.find((candidate) => candidate === rawGroup);
      if (group) spec.orderGroup = { group, negated };
      else invalidTokens.push(token);
      continue;
    }
    if (lower.startsWith('title:')) {
      const parts = parsePipeValue(token.slice(6));
      if (parts) spec.titles.push(parts);
      else invalidTokens.push(token);
      continue;
    }
    if (lower.startsWith('tag:')) {
      const parts = parsePipeValue(token.slice(4));
      if (parts) spec.tags.push(parts);
      else invalidTokens.push(token);
      continue;
    }
    if (lower.startsWith('agent:')) {
      const parts = parsePipeValue(token.slice(6));
      if (parts) spec.agents.push(...parts);
      else invalidTokens.push(token);
      continue;
    }
    if (lower.startsWith('model:')) {
      const parts = parsePipeValue(token.slice(6));
      if (parts) spec.models.push(...parts);
      else invalidTokens.push(token);
      continue;
    }
    if (lower.startsWith('project:')) {
      const parts = parsePipeValue(token.slice(8));
      if (parts) spec.project.push(...parts);
      else invalidTokens.push(token);
      continue;
    }
    if (lower.startsWith('id:')) {
      const parts = parseChatIdGroup(token.slice(3));
      if (parts) (spec.ids ??= []).push(parts);
      else invalidTokens.push(token);
      continue;
    }
    if (lower.startsWith('parent:')) {
      const parts = parseChatIdGroup(token.slice(7));
      if (parts) (spec.parents ??= []).push(parts);
      else invalidTokens.push(token);
      continue;
    }
    const timestampOperator = parseTimestampOperator(token, lower);
    if (timestampOperator) {
      if (timestampOperator.timestamp === null) invalidTokens.push(token);
      else (spec[timestampOperator.field] ??= []).push(timestampOperator.timestamp);
      continue;
    }
    spec.textTokens.push(lower);
  }

  return { spec, invalidTokens };
}

export function parseChatSearch(query: string): ChatFilterSpec {
  return parseChatFilterQuery(query).spec;
}

export function matchesChatFilter(chat: ChatFilterTarget, spec: ChatFilterSpec): boolean {
  if (spec.status === 'active' && !chat.isProcessing) return false;
  if (spec.status === 'unread' && !chat.isUnread) return false;
  if (spec.orderGroup) {
    const group = chatOrderGroupFor(chat);
    if ((group === spec.orderGroup.group) === spec.orderGroup.negated) return false;
  }
  if (spec.ids) {
    for (const group of spec.ids) {
      if (!group.includes(chat.id)) return false;
    }
  }
  if (spec.parents) {
    const parentChatId = chat.parentChat?.chatId ?? null;
    for (const group of spec.parents) {
      if (parentChatId === null || !group.includes(parentChatId)) return false;
    }
  }
  if (!matchesTimeConstraints(chat.createdAt, spec.createdBefore, spec.createdAfter)) return false;
  if (!matchesTimeConstraints(chat.lastActivityAt, spec.updatedBefore, spec.updatedAfter)) {
    return false;
  }
  if (spec.titles.length > 0) {
    const title = chat.title.toLowerCase();
    for (const group of spec.titles) {
      if (!group.some((candidate) => title.includes(candidate))) return false;
    }
  }
  if (spec.project.length > 0) {
    const chatPath = chat.projectPath.toLowerCase();
    if (!spec.project.some((candidate) => chatPath.includes(candidate))) return false;
  }
  if (spec.tags.length > 0) {
    const chatTags = new Set(chat.tags.map((tag) => tag.toLowerCase()));
    for (const group of spec.tags) {
      if (!group.some((tag) => chatTags.has(tag))) return false;
    }
  }
  if (spec.agents.length > 0) {
    const chatAgent = chat.agentId.toLowerCase();
    if (!spec.agents.some((agent) => chatAgent.includes(agent))) return false;
  }
  if (spec.models.length > 0) {
    const chatModel = (chat.model ?? '').toLowerCase();
    if (!spec.models.some((model) => chatModel.includes(model))) return false;
  }
  if (spec.textTokens.length > 0) {
    const haystack = buildHaystack(chat);
    for (const token of spec.textTokens) {
      if (!haystack.includes(token)) return false;
    }
  }
  return true;
}

export function chatOrderGroupFor(chat: {
  readonly isPinned: boolean;
  readonly isArchived: boolean;
}): PersistedChatOrderGroup {
  if (chat.isPinned) return 'pinned';
  if (chat.isArchived) return 'archived';
  return 'normal';
}

export function serializeChatFilter(spec: ChatFilterSpec): string {
  const parts: string[] = [];
  if (spec.status) parts.push(`status:${spec.status}`);
  if (spec.orderGroup) {
    parts.push(`is:${spec.orderGroup.negated ? '!' : ''}${spec.orderGroup.group}`);
  }
  for (const group of spec.titles) {
    parts.push(`title:${serializeOperatorValue(group.join('|'))}`);
  }
  for (const group of spec.tags) parts.push(`tag:${serializeOperatorValue(group.join('|'))}`);
  for (const agent of spec.agents) parts.push(`agent:${serializeOperatorValue(agent)}`);
  for (const model of spec.models) parts.push(`model:${serializeOperatorValue(model)}`);
  if (spec.project.length > 0) {
    parts.push(`project:${serializeOperatorValue(spec.project.join('|'))}`);
  }
  for (const group of spec.ids ?? []) {
    parts.push(`id:${group.join('|')}`);
  }
  for (const group of spec.parents ?? []) {
    parts.push(`parent:${group.join('|')}`);
  }
  for (const value of spec.createdBefore ?? []) parts.push(`created-before:${value}`);
  for (const value of spec.createdAfter ?? []) parts.push(`created-after:${value}`);
  for (const value of spec.updatedBefore ?? []) parts.push(`updated-before:${value}`);
  for (const value of spec.updatedAfter ?? []) parts.push(`updated-after:${value}`);
  for (const text of spec.textTokens) {
    parts.push(text.includes(' ') ? `"${text}"` : text);
  }
  return parts.join(' ');
}

export function addTagToQuery(query: string, tag: string): string {
  if (queryHasTag(query, tag)) return query;
  const prefix = query.trim();
  return prefix ? `${prefix} tag:${tag}` : `tag:${tag}`;
}

export function removeTagFromQuery(query: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\btag:${escaped}\\b`, 'gi');
  return query.replace(pattern, '').replace(/\s{2,}/g, ' ').trim();
}

export function queryHasTag(query: string, tag: string): boolean {
  const spec = parseChatSearch(query);
  return spec.tags.some((group) => group.includes(tag.toLowerCase()));
}

function parsePipeValue(raw: string): string[] | null {
  const parts = raw
    .split('|')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return parts.length > 0 ? parts : null;
}

function parseChatIdGroup(raw: string): string[] | null {
  const parts = parsePipeValue(raw);
  if (!parts) return null;
  try {
    return parts.map((part) => parseChatId(part));
  } catch {
    return null;
  }
}

type TimestampFilterField =
  | 'createdBefore'
  | 'createdAfter'
  | 'updatedBefore'
  | 'updatedAfter';

const TIMESTAMP_OPERATORS: readonly [string, TimestampFilterField][] = [
  ['created-before:', 'createdBefore'],
  ['created-after:', 'createdAfter'],
  ['updated-before:', 'updatedBefore'],
  ['updated-after:', 'updatedAfter'],
];

function parseTimestampOperator(
  token: string,
  lower: string,
): { field: TimestampFilterField; timestamp: string | null } | null {
  const match = TIMESTAMP_OPERATORS.find(([prefix]) => lower.startsWith(prefix));
  if (!match) return null;
  return { field: match[1], timestamp: parseFilterTimestamp(token.slice(match[0].length)) };
}

function parseFilterTimestamp(value: string): string | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!validCalendarDate(year, month, day)) return null;
    return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00.000Z`;
  }

  const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!timestamp) return null;
  const year = Number(timestamp[1]);
  const month = Number(timestamp[2]);
  const day = Number(timestamp[3]);
  const hour = Number(timestamp[4]);
  const minute = Number(timestamp[5]);
  const second = Number(timestamp[6]);
  if (
    !validCalendarDate(year, month, day)
    || hour > 23
    || minute > 59
    || second > 59
    || !validTimezoneOffset(timestamp[8]!)
  ) {
    return null;
  }
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  return year >= 1
    && year <= 9999
    && month >= 1
    && month <= 12
    && day >= 1
    && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validTimezoneOffset(value: string): boolean {
  if (value === 'Z') return true;
  const match = /^[+-](\d{2}):(\d{2})$/u.exec(value);
  return match !== null && Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

function matchesTimeConstraints(
  value: string | null,
  before: readonly string[] | undefined,
  after: readonly string[] | undefined,
): boolean {
  if ((before?.length ?? 0) === 0 && (after?.length ?? 0) === 0) return true;
  if (value === null) return false;
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) return false;
  return (before ?? []).every((limit) => epochMs < Date.parse(limit))
    && (after ?? []).every((limit) => epochMs > Date.parse(limit));
}

function tokenizeChatFilter(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  for (const character of input) {
    if (inQuote) {
      if (character === quoteChar) {
        inQuote = false;
        if (current) tokens.push(current);
        current = '';
      } else {
        current += character;
      }
    } else if ((character === '"' || character === "'") && (current === '' || current.endsWith(':'))) {
      inQuote = true;
      quoteChar = character;
    } else if (character === '"') {
      if (current) tokens.push(current);
      current = '';
      inQuote = true;
      quoteChar = character;
    } else if (character === ' ' || character === '\t') {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function buildHaystack(chat: ChatFilterTarget): string {
  return [
    chat.title,
    chat.projectPath,
    chat.firstMessage ?? '',
    chat.lastMessage ?? '',
    ...chat.tags,
  ].join(' ').toLowerCase();
}

function serializeOperatorValue(value: string): string {
  return /\s/u.test(value) ? `"${value}"` : value;
}
