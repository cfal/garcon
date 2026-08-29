// Shared remote settings contract. Defines the canonical snapshot shape
// returned by GET /api/v1/app/settings and broadcast via the
// settings-changed WebSocket message.

import type { PermissionMode, ThinkingMode } from './chat-modes';
import {
  DEFAULT_PERMISSION_MODE,
  DEFAULT_THINKING_MODE,
  coerceThinkingMode,
  isPermissionMode,
  normalizePermissionMode,
  normalizeThinkingMode,
} from './chat-modes';
import { parseAgentSettingsById, type AgentSettingsEnvelope } from './agent-integration';
import type { AgentId } from './agents';
import { isAgentId } from './agents';
import type { ApiProtocol } from './api-providers';
import { GENERATION_PROMPT_TEMPLATE_MAX_LENGTH } from './generation-prompts';
import {
  parseAgentSwitchContextWindowTokens,
  type AgentSwitchContextWindowTokens,
} from './handoff-sizing';

export type PinnedInsertPosition = 'top' | 'bottom';
export const DEFAULT_APP_TITLE = 'Garcon';
export const APP_TITLE_MAX_LENGTH = 120;

export interface GenerationSelectionUiSettings {
  agentId?: AgentId;
  model?: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  thinkingMode?: ThinkingMode;
}

export interface ChatTitleUiSettings extends GenerationSelectionUiSettings {
  enabled?: boolean;
}

export interface PromptGenerationUiSettings extends GenerationSelectionUiSettings {
  customPrompt?: string;
}

export interface CommitMessageUiSettings extends PromptGenerationUiSettings {
  useCommonDirPrefix?: boolean;
}

export type PromptRefinementUiSettings = PromptGenerationUiSettings;

// Names the model that compacts a carried-over transcript when a chat hands off
// to another agent, or continues in a new chat through `/handoff`.
export interface AgentSwitchCompactionUiSettings extends GenerationSelectionUiSettings {
  enabled?: boolean;
  contextWindowTokens?: AgentSwitchContextWindowTokens;
}

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
  chatTitle?: ChatTitleUiSettings;
  agentSwitchCompaction?: AgentSwitchCompactionUiSettings;
  commitMessage?: CommitMessageUiSettings;
  promptRefinement?: PromptRefinementUiSettings;
  appIdentity?: AppIdentityUiSettings;
  notifications?: {
    telegram?: TelegramNotificationSettings;
  };
}

type EffectiveGenerationSelection = {
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
};

type EffectivePromptGenerationExtras = EffectiveGenerationSelection & {
  customPrompt?: string;
};

type EffectiveCommitMessageExtras = EffectivePromptGenerationExtras & {
  useCommonDirPrefix?: boolean;
};

export interface RemoteUiEffectiveSettings {
  chatTitle?: Required<Pick<ChatTitleUiSettings, 'enabled' | 'agentId' | 'model' | 'thinkingMode'>> &
    EffectiveGenerationSelection;
  agentSwitchCompaction?: Required<
    Pick<
      AgentSwitchCompactionUiSettings,
      'enabled' | 'agentId' | 'model' | 'thinkingMode' | 'contextWindowTokens'
    >
  > & EffectiveGenerationSelection;
  commitMessage?: Required<Pick<CommitMessageUiSettings, 'agentId' | 'model' | 'thinkingMode'>> &
    EffectiveCommitMessageExtras;
  promptRefinement?: Required<
    Pick<PromptRefinementUiSettings, 'agentId' | 'model' | 'thinkingMode'>
  > & EffectivePromptGenerationExtras;
}

export interface RemotePathSettings {
  pinnedProjectPaths: string[];
  browseStartPath: string;
  recentProjectPaths: string[];
}

export interface TranscriptSearchFeatureSettings {
  enabled: boolean;
}

export interface AgentCommandsFeatureSettings {
  enabled: boolean;
  chatIdDiscovery: boolean;
  sendMessage: boolean;
  subAgents: boolean;
}

export interface RemoteFeatureSettings {
  transcriptSearch: TranscriptSearchFeatureSettings;
  agentCommands: AgentCommandsFeatureSettings;
}

export const DEFAULT_REMOTE_FEATURE_SETTINGS: RemoteFeatureSettings = {
  transcriptSearch: { enabled: false },
  agentCommands: {
    enabled: true,
    chatIdDiscovery: true,
    sendMessage: true,
    subAgents: true,
  },
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
  agentSettingsById: Record<string, AgentSettingsEnvelope>;
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
    agentCommands?: Partial<AgentCommandsFeatureSettings>;
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

function normalizeGenerationSelection(
  value: unknown,
): GenerationSelectionUiSettings | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;

  const normalized: GenerationSelectionUiSettings = {};
  if (isAgentId(raw.agentId)) normalized.agentId = raw.agentId;
  if (typeof raw.model === 'string') normalized.model = raw.model;
  if (raw.apiProviderId !== undefined) normalized.apiProviderId = safeOptionalId(raw.apiProviderId);
  if (raw.modelEndpointId !== undefined) normalized.modelEndpointId = safeOptionalId(raw.modelEndpointId);
  if (raw.modelProtocol !== undefined) normalized.modelProtocol = safeOptionalProtocol(raw.modelProtocol);
  const thinkingMode = coerceThinkingMode(raw.thinkingMode);
  if (thinkingMode) normalized.thinkingMode = thinkingMode;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeChatTitleUiSettings(value: unknown): ChatTitleUiSettings | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;

  const normalized: ChatTitleUiSettings = {
    ...normalizeGenerationSelection(raw),
  };
  if (typeof raw.enabled === 'boolean') normalized.enabled = raw.enabled;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeAgentSwitchCompactionUiSettings(
  value: unknown,
): AgentSwitchCompactionUiSettings | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;

  const normalized: AgentSwitchCompactionUiSettings = {
    ...normalizeGenerationSelection(raw),
  };
  if (typeof raw.enabled === 'boolean') normalized.enabled = raw.enabled;
  const contextWindowTokens = parseAgentSwitchContextWindowTokens(raw.contextWindowTokens);
  if (contextWindowTokens !== null) normalized.contextWindowTokens = contextWindowTokens;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeGenerationPromptTemplate(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || value.length > GENERATION_PROMPT_TEMPLATE_MAX_LENGTH
  ) {
    return undefined;
  }
  return value;
}

export function normalizeCommitMessageUiSettings(
  value: unknown,
): CommitMessageUiSettings | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;

  const normalized: CommitMessageUiSettings = {
    ...normalizeGenerationSelection(raw),
  };
  const customPrompt = normalizeGenerationPromptTemplate(raw.customPrompt);
  if (customPrompt !== undefined) normalized.customPrompt = customPrompt;
  if (typeof raw.useCommonDirPrefix === 'boolean') {
    normalized.useCommonDirPrefix = raw.useCommonDirPrefix;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizePromptRefinementUiSettings(
  value: unknown,
): PromptRefinementUiSettings | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;

  const normalized: PromptRefinementUiSettings = {
    ...normalizeGenerationSelection(raw),
  };
  const customPrompt = normalizeGenerationPromptTemplate(raw.customPrompt);
  if (customPrompt !== undefined) normalized.customPrompt = customPrompt;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeAppIdentityUiSettings(value: unknown): AppIdentityUiSettings | undefined {
  const raw = asRecord(value);
  if (!raw || typeof raw.title !== 'string') return undefined;

  const title = raw.title.trim();
  if (!title || title.length > APP_TITLE_MAX_LENGTH) return undefined;
  return { title };
}

function normalizeEffectiveGenerationSelection(
  raw: Record<string, unknown>,
  normalized: EffectiveGenerationSelection,
): void {
  if (raw.apiProviderId !== undefined) normalized.apiProviderId = safeOptionalId(raw.apiProviderId);
  if (raw.modelEndpointId !== undefined) normalized.modelEndpointId = safeOptionalId(raw.modelEndpointId);
  if (raw.modelProtocol !== undefined) normalized.modelProtocol = safeOptionalProtocol(raw.modelProtocol);
}

function normalizeEffectivePromptGenerationExtras(
  raw: Record<string, unknown>,
  normalized: EffectivePromptGenerationExtras,
): void {
  normalizeEffectiveGenerationSelection(raw, normalized);
  const customPrompt = normalizeGenerationPromptTemplate(raw.customPrompt);
  if (customPrompt !== undefined) normalized.customPrompt = customPrompt;
}

function normalizeEffectiveCommitMessageExtras(
  raw: Record<string, unknown>,
  normalized: EffectiveCommitMessageExtras,
): void {
  normalizeEffectivePromptGenerationExtras(raw, normalized);
  if (typeof raw.useCommonDirPrefix === 'boolean') {
    normalized.useCommonDirPrefix = raw.useCommonDirPrefix;
  }
}

function normalizePromptRefinementUiEffectiveSettings(
  value: unknown,
): RemoteUiEffectiveSettings['promptRefinement'] | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  if (!isAgentId(raw.agentId)) return undefined;
  if (typeof raw.model !== 'string') return undefined;

  const normalized: NonNullable<RemoteUiEffectiveSettings['promptRefinement']> = {
    agentId: raw.agentId,
    model: raw.model,
    thinkingMode: normalizeThinkingMode(raw.thinkingMode),
  };
  normalizeEffectivePromptGenerationExtras(raw, normalized);
  return normalized;
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
  normalizeEffectiveGenerationSelection(raw, normalized);
  return normalized;
}

function normalizeAgentSwitchCompactionUiEffectiveSettings(
  value: unknown,
): RemoteUiEffectiveSettings['agentSwitchCompaction'] | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  if (typeof raw.enabled !== 'boolean') return undefined;
  if (!isAgentId(raw.agentId)) return undefined;
  if (typeof raw.model !== 'string') return undefined;
  const contextWindowTokens = parseAgentSwitchContextWindowTokens(raw.contextWindowTokens);
  if (contextWindowTokens === null) return undefined;

  const normalized: NonNullable<RemoteUiEffectiveSettings['agentSwitchCompaction']> = {
    enabled: raw.enabled,
    agentId: raw.agentId,
    model: raw.model,
    thinkingMode: normalizeThinkingMode(raw.thinkingMode),
    contextWindowTokens,
  };
  normalizeEffectiveGenerationSelection(raw, normalized);
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
  normalizeEffectiveCommitMessageExtras(raw, normalized);
  return normalized;
}

function normalizeRemoteUiSettings(value: unknown): RemoteUiSettings | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const normalized: RemoteUiSettings = {};
  if (raw.pinnedInsertPosition === 'top' || raw.pinnedInsertPosition === 'bottom') {
    normalized.pinnedInsertPosition = raw.pinnedInsertPosition;
  }

  const chatTitle = normalizeChatTitleUiSettings(raw.chatTitle);
  if (chatTitle) normalized.chatTitle = chatTitle;

  const agentSwitchCompaction = normalizeAgentSwitchCompactionUiSettings(raw.agentSwitchCompaction);
  if (agentSwitchCompaction) normalized.agentSwitchCompaction = agentSwitchCompaction;

  const commitMessage = normalizeCommitMessageUiSettings(raw.commitMessage);
  if (commitMessage) normalized.commitMessage = commitMessage;

  const promptRefinement = normalizePromptRefinementUiSettings(raw.promptRefinement);
  if (promptRefinement) normalized.promptRefinement = promptRefinement;

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

  const compaction = normalizeAgentSwitchCompactionUiEffectiveSettings(raw.agentSwitchCompaction);
  if (compaction) normalized.agentSwitchCompaction = compaction;

  const commitMessage = normalizeCommitMessageUiEffectiveSettings(raw.commitMessage);
  if (commitMessage) normalized.commitMessage = commitMessage;

  const promptRefinement = normalizePromptRefinementUiEffectiveSettings(raw.promptRefinement);
  if (promptRefinement) normalized.promptRefinement = promptRefinement;

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
  const agentCommands = asRecord(raw?.agentCommands);
  const legacyChatIdDiscovery = asRecord(raw?.chatIdDiscovery);
  const chatIdDiscovery = agentCommands
    ? agentCommands.chatIdDiscovery
    : legacyChatIdDiscovery?.enabled;
  return {
    transcriptSearch: {
      enabled: typeof transcriptSearch?.enabled === 'boolean'
        ? transcriptSearch.enabled
        : false,
    },
    agentCommands: {
      enabled: typeof agentCommands?.enabled === 'boolean'
        ? agentCommands.enabled
        : true,
      chatIdDiscovery: typeof chatIdDiscovery === 'boolean' ? chatIdDiscovery : true,
      sendMessage: typeof agentCommands?.sendMessage === 'boolean'
        ? agentCommands.sendMessage
        : true,
      subAgents: typeof agentCommands?.subAgents === 'boolean'
        ? agentCommands.subAgents
        : true,
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
  const agentSettingsById = normalizeAgentSettingsById(raw.agentSettingsById);
  if (!agentSettingsById) return null;
  return {
    permissionMode: raw.permissionMode,
    thinkingMode,
    agentSettingsById,
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
  if (raw.agentSettingsById !== undefined) {
    const agentSettingsById = normalizeAgentSettingsById(raw.agentSettingsById);
    if (!agentSettingsById) return null;
    patch.agentSettingsById = agentSettingsById;
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
    agentSettingsById: {},
  };
}

function normalizeAgentSettingsById(value: unknown): Record<string, AgentSettingsEnvelope> | null {
  return parseAgentSettingsById(value);
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
