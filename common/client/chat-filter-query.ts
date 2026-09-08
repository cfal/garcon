import {
  PERSISTED_CHAT_ORDER_GROUPS,
  type PersistedChatOrderGroup,
} from '../chat-order-contracts.js';

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
}

export interface ChatFilterParseResult {
  readonly spec: ChatFilterSpec;
  readonly invalidTokens: readonly string[];
}

export interface ChatFilterTarget {
  readonly title: string;
  readonly projectPath: string;
  readonly agentId: string;
  readonly model: string | null;
  readonly tags: readonly string[];
  readonly isProcessing: boolean;
  readonly isUnread: boolean;
  readonly isPinned: boolean;
  readonly isArchived: boolean;
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
    && spec.project.length === 0;
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
