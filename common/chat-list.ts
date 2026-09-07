import type { ApiProtocol } from './api-providers.js';
import type { PermissionMode, ThinkingMode } from './chat-modes.js';
import { isPermissionMode, isThinkingMode } from './chat-modes.js';
import { parseAgentSettingsEnvelope, type AgentSettingsEnvelope } from './agent-integration.js';
import { CHAT_PROCESSING_PHASES, type ChatProcessingPhase } from './chat-types.js';
import { parseParentChatRef, type ParentChatRef } from './chat-parentage.js';
import { parseChatId } from './chat-id.js';
import { isRecord } from './json.js';

export interface ChatListEntry {
  id: string;
  parentChat: ParentChatRef | null;
  agentId: string;
  agentOwnershipEpoch: string;
  model: string | null;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  agentSettings: AgentSettingsEnvelope;
  title: string;
  projectPath: string;
  orderGroup: ChatOrderGroup;
  tags: string[];
  activity: {
    createdAt: string | null;
    lastActivityAt: string | null;
    lastReadAt: string | null;
  };
  preview: {
    lastMessage: string;
    firstMessage?: string;
  };
  isPinned: boolean;
  isArchived: boolean;
  isActive: boolean;
  isProcessing: boolean;
  processingPhase: ChatProcessingPhase | null;
  canReloadFromNativeHistory: boolean;
  isUnread: boolean;
}

export type ChatOrderGroup = 'pinned' | 'orphan' | 'normal' | 'archived';

export interface ChatListResponse {
  sessions: ChatListEntry[];
  total: number;
  lastSelectedChatId: string | null;
}

export class ChatListContractError extends Error {
  constructor(message: string) {
    super(`Invalid chat list response: ${message}`);
    this.name = 'ChatListContractError';
  }
}

export function parseChatListResponse(value: unknown): ChatListResponse {
  if (!isRecord(value) || !Array.isArray(value.sessions)) fail('sessions');
  if (!Number.isSafeInteger(value.total) || Number(value.total) < 0) fail('total');
  const sessions = value.sessions.map((entry, index) => parseChatListEntry(entry, index));
  if (value.total !== sessions.length) fail('total does not match sessions');
  const lastSelectedChatId = value.lastSelectedChatId;
  if (lastSelectedChatId !== null && !validChatId(lastSelectedChatId)) {
    fail('lastSelectedChatId');
  }
  return {
    sessions,
    total: Number(value.total),
    lastSelectedChatId,
  };
}

function parseChatListEntry(value: unknown, index: number): ChatListEntry {
  if (!isRecord(value)) fail(`sessions[${index}]`);
  const field = (name: string) => `sessions[${index}].${name}`;
  if (!validChatId(value.id)) fail(field('id'));
  let parentChat: ParentChatRef | null = null;
  if (value.parentChat !== null) {
    parentChat = parseParentChatRef(value.parentChat);
    if (!parentChat) fail(field('parentChat'));
  }
  const agentId = nonEmptyString(value.agentId, field('agentId'));
  const agentOwnershipEpoch = nonEmptyString(
    value.agentOwnershipEpoch,
    field('agentOwnershipEpoch'),
  );
  const model = nullableString(value.model, field('model'));
  const apiProviderId = optionalNullableString(value.apiProviderId, field('apiProviderId'));
  const modelEndpointId = optionalNullableString(value.modelEndpointId, field('modelEndpointId'));
  const modelProtocol = optionalProtocol(value.modelProtocol, field('modelProtocol'));
  if (!isPermissionMode(value.permissionMode)) fail(field('permissionMode'));
  if (!isThinkingMode(value.thinkingMode)) fail(field('thinkingMode'));
  const agentSettings = parseAgentSettingsEnvelope(value.agentSettings);
  if (!agentSettings || agentSettings.ownerId !== agentId) fail(field('agentSettings'));
  const title = string(value.title, field('title'));
  const projectPath = string(value.projectPath, field('projectPath'));
  if (!['pinned', 'orphan', 'normal', 'archived'].includes(String(value.orderGroup))) {
    fail(field('orderGroup'));
  }
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string')) {
    fail(field('tags'));
  }
  if (!isRecord(value.activity)) fail(field('activity'));
  const createdAt = nullableTimestamp(value.activity.createdAt, `${field('activity')}.createdAt`);
  const lastActivityAt = nullableTimestamp(
    value.activity.lastActivityAt,
    `${field('activity')}.lastActivityAt`,
  );
  const lastReadAt = nullableTimestamp(value.activity.lastReadAt, `${field('activity')}.lastReadAt`);
  if (!isRecord(value.preview)) fail(field('preview'));
  const lastMessage = string(value.preview.lastMessage, `${field('preview')}.lastMessage`);
  const firstMessage = value.preview.firstMessage === undefined
    ? undefined
    : string(value.preview.firstMessage, `${field('preview')}.firstMessage`);
  for (const name of [
    'isPinned',
    'isArchived',
    'isActive',
    'isProcessing',
    'canReloadFromNativeHistory',
    'isUnread',
  ] as const) {
    if (typeof value[name] !== 'boolean') fail(field(name));
  }
  const processingPhase = value.processingPhase;
  if (
    processingPhase !== null
    && !CHAT_PROCESSING_PHASES.includes(processingPhase as ChatProcessingPhase)
  ) fail(field('processingPhase'));
  const processing = processingPhase !== null;
  if (value.isProcessing !== processing || value.isActive !== processing) {
    fail(field('processing state'));
  }
  if (value.isPinned !== (value.orderGroup === 'pinned')) fail(field('isPinned'));
  if (value.isArchived !== (value.orderGroup === 'archived')) fail(field('isArchived'));

  return {
    id: value.id,
    parentChat,
    agentId,
    agentOwnershipEpoch,
    model,
    ...(apiProviderId === undefined ? {} : { apiProviderId }),
    ...(modelEndpointId === undefined ? {} : { modelEndpointId }),
    ...(modelProtocol === undefined ? {} : { modelProtocol }),
    permissionMode: value.permissionMode,
    thinkingMode: value.thinkingMode,
    agentSettings,
    title,
    projectPath,
    orderGroup: value.orderGroup as ChatOrderGroup,
    tags: [...value.tags] as string[],
    activity: { createdAt, lastActivityAt, lastReadAt },
    preview: { lastMessage, ...(firstMessage === undefined ? {} : { firstMessage }) },
    isPinned: value.isPinned,
    isArchived: value.isArchived,
    isActive: value.isActive,
    isProcessing: value.isProcessing,
    processingPhase: processingPhase as ChatProcessingPhase | null,
    canReloadFromNativeHistory: value.canReloadFromNativeHistory as boolean,
    isUnread: value.isUnread as boolean,
  };
}

function validChatId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    parseChatId(value);
    return true;
  } catch {
    return false;
  }
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(field);
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  const parsed = string(value, field);
  if (parsed.length === 0) fail(field);
  return parsed;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, field);
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  return value === undefined ? undefined : nullableString(value, field);
}

function optionalProtocol(value: unknown, field: string): ApiProtocol | null | undefined {
  if (value === undefined || value === null) return value;
  if (value !== 'anthropic-messages' && value !== 'openai-compatible') fail(field);
  return value;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  return string(value, field);
}

function fail(field: string): never {
  throw new ChatListContractError(field);
}

export interface SetLastSelectedChatRequest {
  chatId: string | null;
}

export interface SetLastSelectedChatResponse {
  success: true;
  lastSelectedChatId: string | null;
}

export interface MarkChatsReadEntry {
  chatId: string;
  lastReadAt: string;
}

export interface MarkChatsReadRequest {
  entries: MarkChatsReadEntry[];
}

export interface MarkChatsReadResponse {
  success: true;
  results: MarkChatsReadEntry[];
}
