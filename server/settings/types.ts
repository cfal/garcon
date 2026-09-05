import type { ApiProtocol } from '../../common/api-providers.js';
import type {
  PermissionMode,
  ThinkingMode,
} from '../../common/chat-modes.js';
import type { AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type {
  ReorderChatErrorCode,
  ReorderChatResponse,
} from '../../common/chat-order-contracts.js';
import type {
  AppIdentityUiSettings,
  AgentCommandsFeatureSettings,
  ChatTitleUiSettings,
  CommitMessageUiSettings,
  PromptRefinementUiSettings,
  TranscriptSearchFeatureSettings,
  AgentSwitchCompactionUiSettings,
} from '../../common/settings.js';
import type { HiddenBashCommandPattern } from '../../common/hidden-bash-command-patterns.js';

export interface UiSettings {
  pinnedInsertPosition?: 'top' | 'bottom';
  hiddenBashCommandPatterns?: HiddenBashCommandPattern[];
  chatTitle?: ChatTitleUiSettings;
  agentSwitchCompaction?: AgentSwitchCompactionUiSettings;
  commitMessage?: CommitMessageUiSettings;
  promptRefinement?: PromptRefinementUiSettings;
  appIdentity?: AppIdentityUiSettings;
  [key: string]: unknown;
}

export type PathSettings = Record<string, unknown>;

export interface FolderFilter {
  textTokens: string[];
  tags: string[];
  agents: string[];
  models: string[];
  status?: 'active' | 'unread';
}

export interface ChatFolder {
  id: string;
  name: string;
  filter: FolderFilter;
  createdAt: string;
}

export interface SavedChatSearch {
  id: string;
  title: string | null;
  query: string;
  showAsSidebarPill: boolean;
  showInSidebarMenu: boolean;
  showInSearchDialog: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSettings {
  features: FeatureSettings;
  ui: UiSettings;
  paths: PathSettings;
  chatNames: Record<string, string>;
  remoteSettingsVersion: number;
  pinnedChatIds: string[];
  normalChatIds: string[];
  archivedChatIds: string[];
  recentAgentSettings: RecentAgentSetting[];
  executionDefaults: ExecutionDefaultsSettings;
  chatFolders: ChatFolder[];
  savedChatSearches: SavedChatSearch[];
}

export interface FeatureSettings {
  transcriptSearch: TranscriptSearchFeatureSettings;
  agentCommands: AgentCommandsFeatureSettings;
}

export interface RecentAgentSetting {
  agentId: string;
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

export interface ExecutionDefaultsSettings {
  global: ExecutionDefaults;
  byAgent: Record<string, Partial<ExecutionDefaults>>;
}

export type SettingsMutation<T> = () => T | Promise<T>;

// Chat-start records carry startup preferences as unsanitized fields; the
// store reads only these and ignores the rest of the start command.
export interface ChatStartupPreferences {
  agentId?: unknown;
  projectPath?: unknown;
  model?: unknown;
  apiProviderId?: unknown;
  modelEndpointId?: unknown;
  modelProtocol?: unknown;
  permissionMode?: unknown;
  thinkingMode?: unknown;
  agentSettings?: unknown;
  agentSettingsById?: unknown;
}

export interface SettingsStoreContext {
  readSettings(): ProjectSettings;
  mutate<T>(fn: SettingsMutation<T>): Promise<T>;
  save(settings: ProjectSettings): Promise<void>;
  saveAndMaybeEmitRemote(settings: ProjectSettings, remoteSettingsChanged: boolean): Promise<void>;
  emitSessionNameChanged(chatId: string, title: string): void;
  emitListChanged(reason: string, chatId: string): void;
}

export type ReorderErrorCode =
  | 'ORDER_INVALID_INPUT';

export interface SuccessfulReorder {
  success: true;
}

export interface FailedReorder {
  success: false;
  error: string;
  errorCode: ReorderErrorCode;
  status: number;
}

export type ReorderResult = SuccessfulReorder | FailedReorder;

export interface ValidatedWindowReorder extends SuccessfulReorder {
  success: true;
  oldOrder: string[];
  newOrder: string[];
}

export interface InvalidWindowReorder extends FailedReorder {
  success: false;
}

export type WindowReorderValidation = ValidatedWindowReorder | InvalidWindowReorder;

export interface SuccessfulChatReorder {
  success: true;
  response: ReorderChatResponse;
}

export interface FailedChatReorder {
  success: false;
  error: string;
  errorCode: ReorderChatErrorCode;
  status: number;
}

export type ChatReorderResult = SuccessfulChatReorder | FailedChatReorder;
