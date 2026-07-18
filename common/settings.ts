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
  DEFAULT_AMP_AGENT_MODE,
  DEFAULT_CLAUDE_THINKING_MODE,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_THINKING_MODE,
  coerceThinkingMode,
  isAmpAgentMode,
  isClaudeThinkingMode,
  isPermissionMode,
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingMode,
} from './chat-modes';
import type { AgentId } from './agents';
import { isAgentId } from './agents';
import type { ApiProtocol } from './api-providers';

export type PinnedInsertPosition = 'top' | 'bottom';
export const DEFAULT_APP_TITLE = 'Garcon';
export const APP_TITLE_MAX_LENGTH = 120;

export interface GenerationUiSettings {
  enabled?: boolean;
  agentId?: AgentId;
  model?: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  thinkingMode?: ThinkingMode;
  customPrompt?: string;
  useCommonDirPrefix?: boolean;
}

export type CommitMessageUiSettings = Omit<GenerationUiSettings, 'enabled'>;

export interface TelegramNotificationSettings {
  enabled?: boolean;
}

export interface AppIdentityUiSettings {
  title?: string;
}

export interface RemoteTelegramStatus {
  botTokenAvailable: boolean;
  botUsername: string | null;
  botFirstName: string | null;
  recipientUsername: string | null;
  recipientDisplayName: string | null;
  recipientLinked: boolean;
  pendingLink: boolean;
  linkUrl: string | null;
}

export interface RemoteUiSettings {
  pinnedInsertPosition?: PinnedInsertPosition;
  chatTitle?: GenerationUiSettings;
  commitMessage?: CommitMessageUiSettings;
  appIdentity?: AppIdentityUiSettings;
  notifications?: {
    telegram?: TelegramNotificationSettings;
  };
}

type EffectiveGenerationExtras = {
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  customPrompt?: string;
  useCommonDirPrefix?: boolean;
};

export interface RemoteUiEffectiveSettings {
  chatTitle?: Required<Pick<GenerationUiSettings, 'enabled' | 'agentId' | 'model' | 'thinkingMode'>> &
    EffectiveGenerationExtras;
  commitMessage?: Required<Pick<CommitMessageUiSettings, 'agentId' | 'model' | 'thinkingMode'>> &
    EffectiveGenerationExtras;
}

export interface RemotePathSettings {
  pinnedProjectPaths: string[];
  browseStartPath: string;
  recentProjectPaths: string[];
}

export interface TranscriptSearchFeatureSettings {
  enabled: boolean;
}

export interface RemoteFeatureSettings {
  transcriptSearch: TranscriptSearchFeatureSettings;
}

export const DEFAULT_REMOTE_FEATURE_SETTINGS: RemoteFeatureSettings = {
  transcriptSearch: { enabled: false },
};

export interface RecentAgentSetting {
  agentId: AgentId;
  model: string;
  apiProviderId: string | null;
  modelEndpointId: string | null;
  modelProtocol: ApiProtocol | null;
}

export interface ExecutionDefaults {
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  claudeThinkingMode: ClaudeThinkingMode;
  ampAgentMode: AmpAgentMode;
}

export interface RemoteExecutionDefaults {
  global: ExecutionDefaults;
  byAgent: Partial<Record<AgentId, Partial<ExecutionDefaults>>>;
}

export interface RemoteSettingsSnapshot {
  version: number;
  features: RemoteFeatureSettings;
  ui: RemoteUiSettings;
  uiEffective: RemoteUiEffectiveSettings;
  paths: RemotePathSettings;
  pinnedChatIds: string[];
  recentAgentSettings: RecentAgentSetting[];
  executionDefaults: RemoteExecutionDefaults;
  projectBasePath: string;
  telegram: RemoteTelegramStatus;
}

export interface UpdateRemoteSettingsInput {
  features?: {
    transcriptSearch?: Partial<TranscriptSearchFeatureSettings>;
  };
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

function normalizeGenerationUiSettings(
  value: unknown,
  options: { includeEnabled?: boolean } = {},
): GenerationUiSettings | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;

  const includeEnabled = options.includeEnabled ?? true;
  const normalized: GenerationUiSettings = {};
  if (includeEnabled && typeof raw.enabled === 'boolean') normalized.enabled = raw.enabled;
  if (isAgentId(raw.agentId)) normalized.agentId = raw.agentId;
  if (typeof raw.model === 'string') normalized.model = raw.model;
  if (raw.apiProviderId !== undefined) normalized.apiProviderId = safeOptionalId(raw.apiProviderId);
  if (raw.modelEndpointId !== undefined) normalized.modelEndpointId = safeOptionalId(raw.modelEndpointId);
  if (raw.modelProtocol !== undefined) normalized.modelProtocol = safeOptionalProtocol(raw.modelProtocol);
  const thinkingMode = coerceThinkingMode(raw.thinkingMode);
  if (thinkingMode) normalized.thinkingMode = thinkingMode;
  if (typeof raw.customPrompt === 'string') normalized.customPrompt = raw.customPrompt;
  if (typeof raw.useCommonDirPrefix === 'boolean') {
    normalized.useCommonDirPrefix = raw.useCommonDirPrefix;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeAppIdentityUiSettings(value: unknown): AppIdentityUiSettings | undefined {
  const raw = asRecord(value);
  if (!raw || typeof raw.title !== 'string') return undefined;

  const title = raw.title.trim();
  if (!title || title.length > APP_TITLE_MAX_LENGTH) return undefined;
  return { title };
}

function normalizeEffectiveGenerationExtras(
  raw: Record<string, unknown>,
  normalized: EffectiveGenerationExtras,
): void {
  if (raw.apiProviderId !== undefined) normalized.apiProviderId = safeOptionalId(raw.apiProviderId);
  if (raw.modelEndpointId !== undefined) normalized.modelEndpointId = safeOptionalId(raw.modelEndpointId);
  if (raw.modelProtocol !== undefined) normalized.modelProtocol = safeOptionalProtocol(raw.modelProtocol);
  if (typeof raw.customPrompt === 'string') normalized.customPrompt = raw.customPrompt;
  if (typeof raw.useCommonDirPrefix === 'boolean') {
    normalized.useCommonDirPrefix = raw.useCommonDirPrefix;
  }
}

function normalizeChatTitleUiEffectiveSettings(
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
    thinkingMode: normalizeThinkingMode(raw.thinkingMode),
  };
  normalizeEffectiveGenerationExtras(raw, normalized);
  return normalized;
}

function normalizeCommitMessageUiEffectiveSettings(
  value: unknown,
): RemoteUiEffectiveSettings['commitMessage'] | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  if (!isAgentId(raw.agentId)) return undefined;
  if (typeof raw.model !== 'string') return undefined;

  const normalized: NonNullable<RemoteUiEffectiveSettings['commitMessage']> = {
    agentId: raw.agentId,
    model: raw.model,
    thinkingMode: normalizeThinkingMode(raw.thinkingMode),
  };
  normalizeEffectiveGenerationExtras(raw, normalized);
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

  const commitMessage = normalizeGenerationUiSettings(raw.commitMessage, { includeEnabled: false });
  if (commitMessage) normalized.commitMessage = commitMessage;

  const appIdentity = normalizeAppIdentityUiSettings(raw.appIdentity);
  if (appIdentity) normalized.appIdentity = appIdentity;

  const notifications = asRecord(raw.notifications);
  if (notifications) {
    const telegramRaw = asRecord(notifications.telegram);
      if (telegramRaw) {
        const telegramSettings: TelegramNotificationSettings = {};
        if (typeof telegramRaw.enabled === 'boolean') {
          telegramSettings.enabled = telegramRaw.enabled;
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
  const chatTitle = normalizeChatTitleUiEffectiveSettings(raw.chatTitle);
  if (chatTitle) normalized.chatTitle = chatTitle;

  const commitMessage = normalizeCommitMessageUiEffectiveSettings(raw.commitMessage);
  if (commitMessage) normalized.commitMessage = commitMessage;

  return normalized;
}

function normalizeRemotePathSettings(value: unknown): RemotePathSettings | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const pinnedProjectPaths = asStringArray(raw.pinnedProjectPaths);
  const browseStartPath = asString(raw.browseStartPath);
  const recentProjectPaths = asStringArray(raw.recentProjectPaths);
  if (!pinnedProjectPaths || browseStartPath === null || !recentProjectPaths) return null;
  return { pinnedProjectPaths, browseStartPath, recentProjectPaths };
}

export function normalizeRemoteFeatureSettings(value: unknown): RemoteFeatureSettings {
  const raw = asRecord(value);
  const transcriptSearch = asRecord(raw?.transcriptSearch);
  return {
    transcriptSearch: {
      enabled: typeof transcriptSearch?.enabled === 'boolean'
        ? transcriptSearch.enabled
        : false,
    },
  };
}

function normalizeRemoteSettingsVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizeRecentAgentSetting(value: unknown): RecentAgentSetting | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const model = asString(raw.model);
  if (!isAgentId(raw.agentId) || model === null || !model.trim()) return null;
  return {
    agentId: raw.agentId,
    model,
    apiProviderId: safeOptionalId(raw.apiProviderId),
    modelEndpointId: safeOptionalId(raw.modelEndpointId),
    modelProtocol: safeOptionalProtocol(raw.modelProtocol),
  };
}

function normalizeRecentAgentSettings(value: unknown): RecentAgentSetting[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: RecentAgentSetting[] = [];
  for (const entry of value) {
    const recent = normalizeRecentAgentSetting(entry);
    if (!recent) return null;
    normalized.push(recent);
  }
  return normalized;
}

function normalizeExecutionDefaults(value: unknown): ExecutionDefaults | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (!isPermissionMode(raw.permissionMode)) return null;
  const thinkingMode = coerceThinkingMode(raw.thinkingMode);
  if (!thinkingMode) return null;
  if (!isClaudeThinkingMode(raw.claudeThinkingMode)) return null;
  if (!isAmpAgentMode(raw.ampAgentMode)) return null;
  return {
    permissionMode: raw.permissionMode,
    thinkingMode,
    claudeThinkingMode: raw.claudeThinkingMode,
    ampAgentMode: raw.ampAgentMode,
  };
}

function normalizeExecutionDefaultsPatch(value: unknown): Partial<ExecutionDefaults> | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const patch: Partial<ExecutionDefaults> = {};
  if (raw.permissionMode !== undefined) {
    if (!isPermissionMode(raw.permissionMode)) return null;
    patch.permissionMode = raw.permissionMode;
  }
  if (raw.thinkingMode !== undefined) {
    const thinkingMode = coerceThinkingMode(raw.thinkingMode);
    if (!thinkingMode) return null;
    patch.thinkingMode = thinkingMode;
  }
  if (raw.claudeThinkingMode !== undefined) {
    if (!isClaudeThinkingMode(raw.claudeThinkingMode)) return null;
    patch.claudeThinkingMode = raw.claudeThinkingMode;
  }
  if (raw.ampAgentMode !== undefined) {
    if (!isAmpAgentMode(raw.ampAgentMode)) return null;
    patch.ampAgentMode = raw.ampAgentMode;
  }
  return patch;
}

function normalizeRemoteExecutionDefaults(value: unknown): RemoteExecutionDefaults | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const global = normalizeExecutionDefaults(raw.global);
  const rawByAgent = asRecord(raw.byAgent);
  if (!global || !rawByAgent) return null;

  const byAgent: RemoteExecutionDefaults['byAgent'] = {};
  for (const [agentId, defaults] of Object.entries(rawByAgent)) {
    if (!isAgentId(agentId)) return null;
    const patch = normalizeExecutionDefaultsPatch(defaults);
    if (!patch) return null;
    byAgent[agentId] = patch;
  }

  return { global, byAgent };
}

export function defaultExecutionDefaults(): ExecutionDefaults {
  return {
    permissionMode: normalizePermissionMode(DEFAULT_PERMISSION_MODE),
    thinkingMode: normalizeThinkingMode(DEFAULT_THINKING_MODE),
    claudeThinkingMode: normalizeClaudeThinkingMode(DEFAULT_CLAUDE_THINKING_MODE),
    ampAgentMode: normalizeAmpAgentMode(DEFAULT_AMP_AGENT_MODE),
  };
}

function normalizeRemoteTelegramStatus(value: unknown): RemoteTelegramStatus | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (typeof raw.botTokenAvailable !== 'boolean') return null;
  if (typeof raw.recipientLinked !== 'boolean') return null;
  if (typeof raw.pendingLink !== 'boolean') return null;

  const botUsername = normalizeNullableString(raw.botUsername);
  const botFirstName = normalizeNullableString(raw.botFirstName);
  const recipientUsername = normalizeNullableString(raw.recipientUsername);
  const recipientDisplayName = normalizeNullableString(raw.recipientDisplayName);
  const linkUrl = normalizeNullableString(raw.linkUrl);

  if (botUsername === null && raw.botUsername !== undefined && raw.botUsername !== null) return null;
  if (botFirstName === null && raw.botFirstName !== undefined && raw.botFirstName !== null) return null;
  if (recipientUsername === null && raw.recipientUsername !== undefined && raw.recipientUsername !== null) return null;
  if (recipientDisplayName === null && raw.recipientDisplayName !== undefined && raw.recipientDisplayName !== null) return null;
  if (linkUrl === null && raw.linkUrl !== undefined && raw.linkUrl !== null) return null;

  return {
    botTokenAvailable: raw.botTokenAvailable,
    botUsername,
    botFirstName,
    recipientUsername,
    recipientDisplayName,
    recipientLinked: raw.recipientLinked,
    pendingLink: raw.pendingLink,
    linkUrl,
  };
}

export function normalizeRemoteSettingsSnapshot(value: unknown): RemoteSettingsSnapshot | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const version = normalizeRemoteSettingsVersion(raw.version);
  const features = normalizeRemoteFeatureSettings(raw.features);
  const ui = normalizeRemoteUiSettings(raw.ui);
  const uiEffective = normalizeRemoteUiEffectiveSettings(raw.uiEffective);
  const paths = normalizeRemotePathSettings(raw.paths);
  const pinnedChatIds = asStringArray(raw.pinnedChatIds);
  const projectBasePath = asString(raw.projectBasePath);
  const recentAgentSettings = normalizeRecentAgentSettings(raw.recentAgentSettings);
  const executionDefaults = normalizeRemoteExecutionDefaults(raw.executionDefaults);
  const telegram = normalizeRemoteTelegramStatus(raw.telegram);

  if (version === null) return null;
  if (!ui || !uiEffective || !paths || !pinnedChatIds) return null;
  if (projectBasePath === null || !recentAgentSettings || !executionDefaults) return null;
  if (!telegram) return null;

  return {
    version,
    features,
    ui,
    uiEffective,
    paths,
    pinnedChatIds,
    recentAgentSettings,
    executionDefaults,
    projectBasePath,
    telegram,
  };
}
