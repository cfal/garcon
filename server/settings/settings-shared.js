export function normalizeUiSettings(ui) {
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return {};
  const normalized = { ...ui };
  if ('pinnedInsertPosition' in normalized) {
    normalized.pinnedInsertPosition = normalized.pinnedInsertPosition === 'bottom' ? 'bottom' : 'top';
  }
  return normalized;
}

export function sanitizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : [];
}

const FOLDER_FILTER_KEYS = ['textTokens', 'tags', 'agents', 'models'];
const VALID_FOLDER_FILTER_STATUS = new Set(['active', 'unread']);

export function sanitizeFolderFilter(raw) {
  const filter = { textTokens: [], tags: [], agents: [], models: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return filter;

  for (const key of FOLDER_FILTER_KEYS) {
    filter[key] = sanitizeStringArray(raw[key]);
  }

  if (typeof raw.status === 'string') {
    const status = raw.status.trim();
    if (VALID_FOLDER_FILTER_STATUS.has(status)) filter.status = status;
  }

  return filter;
}

export function normalizeRemoteSettingsVersion(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
