import { isExecutorId, type ExecutorId } from './executors.js';
import { isRecord } from './json.js';
import { normalizeRemoteSettingsSnapshot, type RemoteSettingsSnapshot } from './settings.js';

export interface RemoveProjectPathRequest {
  executorId: ExecutorId;
  projectPath: string;
}

export interface RemoveProjectPathResponse {
  success: true;
  settings: RemoteSettingsSnapshot;
}

/** Preserves exact POSIX paths while matching drive-letter slash aliases. */
export function projectPathKey(path: string): string {
  return /^[a-z]:[/\\]/i.test(path) ? path.replaceAll('\\', '/') : path;
}

export function parseRemoveProjectPathRequest(value: unknown): RemoveProjectPathRequest | null {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'executorId' && key !== 'projectPath')) return null;
  if (!isExecutorId(value.executorId) || typeof value.projectPath !== 'string' || !value.projectPath.trim()) return null;
  return { executorId: value.executorId, projectPath: value.projectPath };
}

export function parseRemoveProjectPathResponse(value: unknown): RemoveProjectPathResponse | null {
  if (!isRecord(value) || value.success !== true || Object.keys(value).some(key => key !== 'success' && key !== 'settings')) return null;
  const settings = normalizeRemoteSettingsSnapshot(value.settings);
  return settings ? { success: true, settings } : null;
}
