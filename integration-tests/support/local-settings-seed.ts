// Init-script body that merges overrides into the persisted local-settings
// snapshot before the SPA boots. Passed as a Playwright addInitScript or
// Puppeteer evaluateOnNewDocument callback, so it must stay self-contained
// (no closures over module state).
export function seedLocalSettings(overrides: Record<string, unknown>): void {
  const key = 'pref_local_settings';
  try {
    const stored = JSON.parse(globalThis.localStorage.getItem(key) ?? '{}');
    const snapshot = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    globalThis.localStorage.setItem(key, JSON.stringify({ ...snapshot, ...overrides }));
  } catch {
    globalThis.localStorage.setItem(key, JSON.stringify(overrides));
  }
}
