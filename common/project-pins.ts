import { projectPathKey } from './project-path-preferences.js';

export const PROJECT_PIN_LIMIT = 5;

/** Preserves order while deduplicating executor-local path identities. */
export function orderedProjectPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths = new Map<string, string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    if (!paths.has(projectPathKey(entry))) paths.set(projectPathKey(entry), entry);
  }
  return [...paths.values()];
}

/** Retains the newest five pins and keeps displaced projects in recents. */
export function reconcileProjectPins(previous: unknown, requested: unknown, recents: unknown): {
  pinnedPaths: string[];
  recentPaths: string[];
} {
  const before = orderedProjectPaths(previous);
  const desired = orderedProjectPaths(requested);
  const desiredKeys = new Set(desired.map(projectPathKey));
  const beforeKeys = new Set(before.map(projectPathKey));
  const ordered = [
    ...before.filter(path => desiredKeys.has(projectPathKey(path))),
    ...desired.filter(path => !beforeKeys.has(projectPathKey(path))),
  ];
  const pinnedPaths = ordered.slice(-PROJECT_PIN_LIMIT);
  const retainedKeys = new Set(pinnedPaths.map(projectPathKey));
  const unpinned = orderedProjectPaths([...before, ...ordered])
    .filter(path => !retainedKeys.has(projectPathKey(path)));
  return { pinnedPaths, recentPaths: orderedProjectPaths([...unpinned, ...orderedProjectPaths(recents)]) };
}
