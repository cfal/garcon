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

const CHAT_ORDER_GROUPS: readonly ChatOrderGroup[] = [
  'pinned',
  'orphan',
  'normal',
  'archived',
];

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
  const total = requireNonNegativeInteger(value.total, 'total');
  const sessions = value.sessions.map((entry, index) => parseChatListEntry(entry, index));
  if (total !== sessions.length) fail('total does not match sessions');
  const lastSelectedChatId = value.lastSelectedChatId;
  if (lastSelectedChatId !== null && !validChatId(lastSelectedChatId)) {
    fail('lastSelectedChatId');
  }
  return {
    sessions,
    total,
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
  const title = requireString(value.title, field('title'));
  const projectPath = requireString(value.projectPath, field('projectPath'));
  if (!CHAT_ORDER_GROUPS.includes(String(value.orderGroup) as ChatOrderGroup)) {
    fail(field('orderGroup'));
  }
  const orderGroup = value.orderGroup as ChatOrderGroup;
  const tags = requireStringArray(value.tags, field('tags'));
  if (!isRecord(value.activity)) fail(field('activity'));
  const createdAt = nullableTimestamp(value.activity.createdAt, `${field('activity')}.createdAt`);
  const lastActivityAt = nullableTimestamp(
    value.activity.lastActivityAt,
    `${field('activity')}.lastActivityAt`,
  );
  const lastReadAt = nullableTimestamp(value.activity.lastReadAt, `${field('activity')}.lastReadAt`);
  if (!isRecord(value.preview)) fail(field('preview'));
  const lastMessage = requireString(value.preview.lastMessage, `${field('preview')}.lastMessage`);
  const firstMessage = value.preview.firstMessage === undefined
    ? undefined
    : requireString(value.preview.firstMessage, `${field('preview')}.firstMessage`);
  const isPinned = requireBoolean(value.isPinned, field('isPinned'));
  const isArchived = requireBoolean(value.isArchived, field('isArchived'));
  const isActive = requireBoolean(value.isActive, field('isActive'));
  const isProcessing = requireBoolean(value.isProcessing, field('isProcessing'));
  const canReloadFromNativeHistory = requireBoolean(
    value.canReloadFromNativeHistory,
    field('canReloadFromNativeHistory'),
  );
  const isUnread = requireBoolean(value.isUnread, field('isUnread'));
  const processingPhase = value.processingPhase;
  if (processingPhase !== null && !isChatProcessingPhase(processingPhase)) {
    fail(field('processingPhase'));
  }
  const processing = processingPhase !== null;
  if (isProcessing !== processing || isActive !== processing) {
    fail(field('processing state'));
  }
  if (isPinned !== (orderGroup === 'pinned')) fail(field('isPinned'));
  if (isArchived !== (orderGroup === 'archived')) fail(field('isArchived'));

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
    orderGroup,
    tags,
    activity: { createdAt, lastActivityAt, lastReadAt },
    preview: { lastMessage, ...(firstMessage === undefined ? {} : { firstMessage }) },
    isPinned,
    isArchived,
    isActive,
    isProcessing,
    processingPhase,
    canReloadFromNativeHistory,
    isUnread,
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(field);
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  const parsed = requireString(value, field);
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
  return requireString(value, field);
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(field);
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) fail(field);
  return [...value];
}

function isChatProcessingPhase(value: unknown): value is ChatProcessingPhase {
  return typeof value === 'string'
    && (CHAT_PROCESSING_PHASES as readonly string[]).includes(value);
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
