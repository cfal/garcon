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

export function normalizeRemoteSettingsVersion(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
