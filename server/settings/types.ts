import type { ApiProtocol } from '../../common/api-providers.js';
import type {
  AmpAgentMode,
  ClaudeThinkingMode,
  PermissionMode,
  ThinkingMode,
} from '../../common/chat-modes.js';

export interface UiSettings {
  pinnedInsertPosition?: 'top' | 'bottom';
  chatTitle?: unknown;
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
  claudeThinkingMode: ClaudeThinkingMode;
  ampAgentMode: AmpAgentMode;
}

export interface ExecutionDefaultsSettings {
  global: ExecutionDefaults;
  byAgent: Record<string, Partial<ExecutionDefaults>>;
}

export type SettingsMutation<T> = () => T | Promise<T>;

export interface SettingsStoreContext {
  readSettings(): ProjectSettings;
  mutate<T>(fn: SettingsMutation<T>): Promise<T>;
  save(settings: ProjectSettings): Promise<void>;
  saveAndMaybeEmitRemote(settings: ProjectSettings, remoteSettingsChanged: boolean): Promise<void>;
  emitSessionNameChanged(chatId: string, title: string): void;
  emitListChanged(reason: string, chatId: string): void;
}

export interface ReorderResult {
  success: boolean;
  error?: string;
}

export interface ValidatedWindowReorder extends ReorderResult {
  success: true;
  oldOrder: string[];
  newOrder: string[];
}

export interface InvalidWindowReorder extends ReorderResult {
  success: false;
  error: string;
}

export type WindowReorderValidation = ValidatedWindowReorder | InvalidWindowReorder;
