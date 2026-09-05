import type { FolderFilter, UiSettings } from './types.js';
import {
  APP_TITLE_MAX_LENGTH,
  normalizeAgentSwitchCompactionUiSettings,
  normalizeChatTitleUiSettings,
  normalizeCommitMessageUiSettings,
  normalizePromptRefinementUiSettings,
} from '../../common/settings.js';
import { parseHiddenBashCommandPatterns } from '../../common/hidden-bash-command-patterns.js';

function normalizeAppIdentitySettings(value: unknown): { title: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== 'string') return undefined;
  const title = raw.title.trim();
  if (!title || title.length > APP_TITLE_MAX_LENGTH) return undefined;
  return { title };
}

export function normalizeUiSettings(ui: unknown): UiSettings {
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return {};
  const normalized: UiSettings = { ...ui };
  const appIdentity = normalizeAppIdentitySettings(normalized.appIdentity);
  if (appIdentity) {
    normalized.appIdentity = appIdentity;
  } else {
    delete normalized.appIdentity;
  }
  if ('pinnedInsertPosition' in normalized) {
    normalized.pinnedInsertPosition = normalized.pinnedInsertPosition === 'bottom' ? 'bottom' : 'top';
  }
  if ('hiddenBashCommandPatterns' in normalized) {
    const patterns = parseHiddenBashCommandPatterns(normalized.hiddenBashCommandPatterns);
    if (patterns !== null) normalized.hiddenBashCommandPatterns = patterns;
    else delete normalized.hiddenBashCommandPatterns;
  }
  if ('chatTitle' in normalized) {
    const chatTitle = normalizeChatTitleUiSettings(normalized.chatTitle);
    if (chatTitle) normalized.chatTitle = chatTitle;
    else delete normalized.chatTitle;
  }
  if ('agentSwitchCompaction' in normalized) {
    const compaction = normalizeAgentSwitchCompactionUiSettings(normalized.agentSwitchCompaction);
    if (compaction) normalized.agentSwitchCompaction = compaction;
    else delete normalized.agentSwitchCompaction;
  }
  if ('commitMessage' in normalized) {
    const commitMessage = normalizeCommitMessageUiSettings(normalized.commitMessage);
    if (commitMessage) normalized.commitMessage = commitMessage;
    else delete normalized.commitMessage;
  }
  if ('promptRefinement' in normalized) {
    const promptRefinement = normalizePromptRefinementUiSettings(normalized.promptRefinement);
    if (promptRefinement) normalized.promptRefinement = promptRefinement;
    else delete normalized.promptRefinement;
  }
  return normalized;
}

export function sanitizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : [];
}

const FOLDER_FILTER_KEYS = ['textTokens', 'tags', 'agents', 'models'] as const;

export function sanitizeFolderFilter(raw: unknown): FolderFilter {
  const filter: FolderFilter = { textTokens: [], tags: [], agents: [], models: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return filter;

  for (const key of FOLDER_FILTER_KEYS) {
    filter[key] = sanitizeStringArray((raw as Record<string, unknown>)[key]);
  }

  const rawRecord = raw as Record<string, unknown>;
  if (typeof rawRecord.status === 'string') {
    const status = rawRecord.status.trim();
    if (status === 'active' || status === 'unread') filter.status = status;
  }

  return filter;
}

export function normalizeRemoteSettingsVersion(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
