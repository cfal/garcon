import type { FolderFilter, UiSettings } from './types.js';

export function normalizeUiSettings(ui: unknown): UiSettings {
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return {};
  const normalized = { ...ui };
  if ('pinnedInsertPosition' in normalized) {
    normalized.pinnedInsertPosition = normalized.pinnedInsertPosition === 'bottom' ? 'bottom' : 'top';
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
