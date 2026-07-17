import type { FolderFilter, UiSettings } from './types.js';
import { APP_TITLE_MAX_LENGTH } from '../../common/settings.js';

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
  const commitMessage = normalized.commitMessage;
  if (commitMessage && typeof commitMessage === 'object' && !Array.isArray(commitMessage)) {
    const nextCommitMessage = { ...(commitMessage as Record<string, unknown>) };
    delete nextCommitMessage.enabled;
    if (Object.keys(nextCommitMessage).length > 0) {
      normalized.commitMessage = nextCommitMessage;
    } else {
      delete normalized.commitMessage;
    }
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
