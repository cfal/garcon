// Shared remote settings contract. Defines the canonical snapshot shape
// returned by GET /api/v1/app/settings and broadcast via the
// settings-changed WebSocket message.

import type {
  AmpAgentMode,
  ClaudeThinkingMode,
  PermissionMode,
  ThinkingMode,
} from './chat-modes';
import {
  isAmpAgentMode,
  isClaudeThinkingMode,
  isPermissionMode,
  isThinkingMode,
} from './chat-modes';
import type { AgentId } from './agents';
import { isAgentId } from './agents';
import type { ApiProtocol } from './api-providers';

export type PinnedInsertPosition = 'top' | 'bottom';

export interface GenerationUiSettings {
  enabled?: boolean;
  agentId?: AgentId;
  model?: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  customPrompt?: string;
  useCommonDirPrefix?: boolean;
}

export interface TelegramNotificationSettings {
  enabled?: boolean;
  chatId?: string;
}

export interface RemoteUiSettings {
  pinnedInsertPosition?: PinnedInsertPosition;
  chatTitle?: GenerationUiSettings;
  commitMessage?: GenerationUiSettings;
  notifications?: {
    telegram?: TelegramNotificationSettings;
  };
}

export interface RemoteUiEffectiveSettings {
  chatTitle?: Required<Pick<GenerationUiSettings, 'enabled' | 'agentId' | 'model'>> & {
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
    modelProtocol?: ApiProtocol | null;
    customPrompt?: string;
    useCommonDirPrefix?: boolean;
  };
  commitMessage?: Required<Pick<GenerationUiSettings, 'enabled' | 'agentId' | 'model'>> & {
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
    modelProtocol?: ApiProtocol | null;
    customPrompt?: string;
    useCommonDirPrefix?: boolean;
  };
}

export interface RemotePathSettings {
  pinnedProjectPaths: string[];
  browseStartPath: string;
}

export interface RemoteSettingsSnapshot {
  version: number;
  ui: RemoteUiSettings;
  uiEffective: RemoteUiEffectiveSettings;
  paths: RemotePathSettings;
  pinnedChatIds: string[];
  lastAgentId: AgentId;
  lastProjectPath: string;
  lastModel: string;
  lastApiProviderId: string | null;
  lastModelEndpointId: string | null;
  lastModelProtocol: ApiProtocol | null;
  lastPermissionMode: PermissionMode;
  lastThinkingMode: ThinkingMode;
  lastClaudeThinkingMode: ClaudeThinkingMode;
  lastAmpAgentMode: AmpAgentMode;
  projectBasePath: string;
  telegramBotTokenAvailable: boolean;
}

export interface UpdateRemoteSettingsInput {
  ui?: Partial<RemoteUiSettings>;
  paths?: Partial<RemotePathSettings>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((entry) => typeof entry === 'string')) return null;
  return value as string[];
}

function safeOptionalId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(value)
    ? value
    : null;
}

function safeOptionalProtocol(value: unknown): ApiProtocol | null {
  if (value === 'openai-compatible' || value === 'anthropic-messages') return value;
  return null;
}

function normalizeGenerationUiSettings(value: unknown): GenerationUiSettings | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;

  const normalized: GenerationUiSettings = {};
  if (typeof raw.enabled === 'boolean') normalized.enabled = raw.enabled;
  if (isAgentId(raw.agentId)) normalized.agentId = raw.agentId;
  if (typeof raw.model === 'string') normalized.model = raw.model;
  if (raw.apiProviderId !== undefined) normalized.apiProviderId = safeOptionalId(raw.apiProviderId);
  if (raw.modelEndpointId !== undefined) normalized.modelEndpointId = safeOptionalId(raw.modelEndpointId);
  if (raw.modelProtocol !== undefined) normalized.modelProtocol = safeOptionalProtocol(raw.modelProtocol);
  if (typeof raw.customPrompt === 'string') normalized.customPrompt = raw.customPrompt;
  if (typeof raw.useCommonDirPrefix === 'boolean') {
    normalized.useCommonDirPrefix = raw.useCommonDirPrefix;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeGenerationUiEffectiveSettings(
  value: unknown,
): RemoteUiEffectiveSettings['chatTitle'] | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  if (typeof raw.enabled !== 'boolean') return undefined;
  if (!isAgentId(raw.agentId)) return undefined;
  if (typeof raw.model !== 'string') return undefined;

  const normalized: NonNullable<RemoteUiEffectiveSettings['chatTitle']> = {
    enabled: raw.enabled,
    agentId: raw.agentId,
    model: raw.model,
  };
  if (raw.apiProviderId !== undefined) normalized.apiProviderId = safeOptionalId(raw.apiProviderId);
  if (raw.modelEndpointId !== undefined) normalized.modelEndpointId = safeOptionalId(raw.modelEndpointId);
  if (raw.modelProtocol !== undefined) normalized.modelProtocol = safeOptionalProtocol(raw.modelProtocol);
  if (typeof raw.customPrompt === 'string') normalized.customPrompt = raw.customPrompt;
  if (typeof raw.useCommonDirPrefix === 'boolean') {
    normalized.useCommonDirPrefix = raw.useCommonDirPrefix;
  }
  return normalized;
}

function normalizeRemoteUiSettings(value: unknown): RemoteUiSettings | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const normalized: RemoteUiSettings = {};
  if (raw.pinnedInsertPosition === 'top' || raw.pinnedInsertPosition === 'bottom') {
    normalized.pinnedInsertPosition = raw.pinnedInsertPosition;
  }

  const chatTitle = normalizeGenerationUiSettings(raw.chatTitle);
  if (chatTitle) normalized.chatTitle = chatTitle;

  const commitMessage = normalizeGenerationUiSettings(raw.commitMessage);
  if (commitMessage) normalized.commitMessage = commitMessage;

  const notifications = asRecord(raw.notifications);
  if (notifications) {
    const telegramRaw = asRecord(notifications.telegram);
    if (telegramRaw) {
      const telegramSettings: TelegramNotificationSettings = {};
      if (typeof telegramRaw.enabled === 'boolean') {
        telegramSettings.enabled = telegramRaw.enabled;
      }
      if (typeof telegramRaw.chatId === 'string') {
        telegramSettings.chatId = telegramRaw.chatId;
      }
      if (Object.keys(telegramSettings).length > 0) {
        normalized.notifications = { telegram: telegramSettings };
      }
    }
  }

  return normalized;
}

function normalizeRemoteUiEffectiveSettings(value: unknown): RemoteUiEffectiveSettings | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const normalized: RemoteUiEffectiveSettings = {};
  const chatTitle = normalizeGenerationUiEffectiveSettings(raw.chatTitle);
  if (chatTitle) normalized.chatTitle = chatTitle;

  const commitMessage = normalizeGenerationUiEffectiveSettings(raw.commitMessage);
  if (commitMessage) normalized.commitMessage = commitMessage;

  return normalized;
}

function normalizeRemotePathSettings(value: unknown): RemotePathSettings | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const pinnedProjectPaths = asStringArray(raw.pinnedProjectPaths);
  const browseStartPath = asString(raw.browseStartPath);
  if (!pinnedProjectPaths || browseStartPath === null) return null;
  return { pinnedProjectPaths, browseStartPath };
}

function normalizeRemoteSettingsVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function normalizeRemoteSettingsSnapshot(value: unknown): RemoteSettingsSnapshot | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const version = normalizeRemoteSettingsVersion(raw.version);
  const ui = normalizeRemoteUiSettings(raw.ui);
  const uiEffective = normalizeRemoteUiEffectiveSettings(raw.uiEffective);
  const paths = normalizeRemotePathSettings(raw.paths);
  const pinnedChatIds = asStringArray(raw.pinnedChatIds);
  const lastProjectPath = asString(raw.lastProjectPath);
  const lastModel = asString(raw.lastModel);
  const projectBasePath = asString(raw.projectBasePath);
  const lastApiProviderId = safeOptionalId(raw.lastApiProviderId);
  const lastModelEndpointId = safeOptionalId(raw.lastModelEndpointId);
  const lastModelProtocol = safeOptionalProtocol(raw.lastModelProtocol);

  if (version === null) return null;
  if (!ui || !uiEffective || !paths || !pinnedChatIds) return null;
  if (!isAgentId(raw.lastAgentId)) return null;
  if (lastProjectPath === null || lastModel === null || projectBasePath === null) return null;
  if (!isPermissionMode(raw.lastPermissionMode)) return null;
  if (!isThinkingMode(raw.lastThinkingMode)) return null;
  if (!isClaudeThinkingMode(raw.lastClaudeThinkingMode)) return null;
  if (!isAmpAgentMode(raw.lastAmpAgentMode)) return null;
  if (typeof raw.telegramBotTokenAvailable !== 'boolean') return null;

  return {
    version,
    ui,
    uiEffective,
    paths,
    pinnedChatIds,
    lastAgentId: raw.lastAgentId,
    lastProjectPath,
    lastModel,
    lastApiProviderId,
    lastModelEndpointId,
    lastModelProtocol,
    lastPermissionMode: raw.lastPermissionMode,
    lastThinkingMode: raw.lastThinkingMode,
    lastClaudeThinkingMode: raw.lastClaudeThinkingMode,
    lastAmpAgentMode: raw.lastAmpAgentMode,
    projectBasePath,
    telegramBotTokenAvailable: raw.telegramBotTokenAvailable,
  };
}
