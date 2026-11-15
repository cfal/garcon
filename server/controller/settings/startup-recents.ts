import type { ApiProtocol } from '../../../common/api-providers.js';
import {
  DEFAULT_PERMISSION_MODE,
  DEFAULT_THINKING_MODE,
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../../common/chat-modes.js';
import { parseAgentSettingsById } from '../../../common/agent-integration.js';
import { isRecord } from '../../../common/json.js';
import { orderedProjectPaths, reconcileProjectPins } from '../../../common/project-pins.js';
import { effectiveExecutorId, parseExecutorId, LOCAL_EXECUTOR_ID } from '../../../common/executors.js';
import { parseExecutorProjectPreferences, type ExecutorProjectPreferences } from '../../../common/settings.js';
import type {
  ExecutionDefaults,
  ExecutionDefaultsSettings,
  PathSettings,
  ProjectSettings,
  RecentAgentSetting,
} from './types.js';

export const RECENT_AGENT_SETTINGS_PER_EXECUTOR_LIMIT = 20;
const EXECUTION_DEFAULT_KEYS = [
  'permissionMode',
  'thinkingMode',
  'agentSettingsById',
] as const;

function optionalString(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

function normalizeProtocol(value: unknown): ApiProtocol | null {
  if (value === 'openai-compatible' || value === 'anthropic-messages') return value;
  return null;
}

function optionalPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function sameStringArray(left: unknown, right: string[]): boolean {
  if (!Array.isArray(left)) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Reads valid owners independently while leaving malformed stored entries recoverable. */
export function readExecutorProjectPreferences(value: unknown): Record<string, ExecutorProjectPreferences> {
  if (!isRecord(value)) return {};
  const preferences: Record<string, ExecutorProjectPreferences> = {};
  for (const [id, entry] of Object.entries(value)) {
    const parsed = parseExecutorProjectPreferences({ [id]: entry });
    if (parsed?.[id]) preferences[id] = parsed[id];
  }
  return preferences;
}

export function normalizePathSettings(paths: PathSettings): PathSettings {
  const normalized = { ...paths };
  if (Array.isArray(paths.pinnedProjectPaths)) {
    const pins = reconcileProjectPins([], paths.pinnedProjectPaths, paths.recentProjectPaths);
    normalized.pinnedProjectPaths = pins.pinnedPaths;
    normalized.recentProjectPaths = pins.recentPaths;
  }
  if (isRecord(paths.byExecutor)) {
    const byExecutor = { ...paths.byExecutor };
    for (const [id, preferences] of Object.entries(readExecutorProjectPreferences(byExecutor))) {
      const rawPreferences = byExecutor[id];
      byExecutor[id] = { ...(isRecord(rawPreferences) ? rawPreferences : {}),
        ...reconcileProjectPins([], preferences.pinnedPaths, preferences.recentPaths) };
    }
    normalized.byExecutor = byExecutor;
  }
  return normalized;
}

export function withoutExecutorStartupPreferences(
  settings: Pick<ProjectSettings, 'paths' | 'recentAgentSettings'>,
  executorId: string,
): Pick<ProjectSettings, 'paths' | 'recentAgentSettings'> {
  const byExecutor = isRecord(settings.paths.byExecutor) ? { ...settings.paths.byExecutor } : null;
  if (byExecutor) delete byExecutor[executorId];
  return {
    paths: byExecutor ? { ...settings.paths, byExecutor } : settings.paths,
    recentAgentSettings: settings.recentAgentSettings.filter((entry) => entry.executorId !== executorId),
  };
}

export function recentAgentSettingKey(entry: RecentAgentSetting): string {
  return [
    effectiveExecutorId(entry.executorId),
    entry.agentId,
    entry.model,
    entry.apiProviderId ?? '',
    entry.modelEndpointId ?? '',
    entry.modelProtocol ?? '',
  ].join('\u001f');
}

export function sanitizeRecentAgentSetting(raw: unknown): RecentAgentSetting | null {
  if (!isRecord(raw)) return null;
  const agentId = optionalString(raw.agentId);
  const model = optionalString(raw.model);
  if (!agentId || !model) return null;
  const executorId = parseExecutorId(raw.executorId);
  if (!executorId) return null;

  return {
    ...(executorId !== LOCAL_EXECUTOR_ID ? { executorId } : {}),
    agentId,
    model,
    apiProviderId: optionalString(raw.apiProviderId),
    modelEndpointId: optionalString(raw.modelEndpointId),
    modelProtocol: normalizeProtocol(raw.modelProtocol),
  };
}

export function defaultExecutionDefaults(): ExecutionDefaults {
  return {
    permissionMode: DEFAULT_PERMISSION_MODE,
    thinkingMode: DEFAULT_THINKING_MODE,
    agentSettingsById: {},
  };
}

export function sanitizeExecutionDefaults(raw: unknown): ExecutionDefaults {
  const source = isRecord(raw) ? raw : {};
  return {
    permissionMode: normalizePermissionMode(source.permissionMode),
    thinkingMode: normalizeThinkingMode(source.thinkingMode),
    agentSettingsById: parseAgentSettingsById(source.agentSettingsById) ?? {},
  };
}

export function sanitizeExecutionDefaultsPatch(raw: unknown): Partial<ExecutionDefaults> {
  if (!isRecord(raw)) return {};
  const patch: Partial<ExecutionDefaults> = {};
  if (raw.permissionMode !== undefined) {
    patch.permissionMode = normalizePermissionMode(raw.permissionMode);
  }
  if (raw.thinkingMode !== undefined) {
    patch.thinkingMode = normalizeThinkingMode(raw.thinkingMode);
  }
  if (raw.agentSettingsById !== undefined) {
    const settings = parseAgentSettingsById(raw.agentSettingsById);
    if (settings) patch.agentSettingsById = settings;
  }
  return patch;
}

export function sanitizeExecutionDefaultsSettings(raw: unknown): {
  defaults: ExecutionDefaultsSettings;
  migrated: boolean;
} {
  if (!isRecord(raw)) {
    return {
      defaults: {
        global: defaultExecutionDefaults(),
        byAgent: {},
      },
      migrated: true,
    };
  }

  const global = sanitizeExecutionDefaults(raw.global);
  const rawGlobal = isRecord(raw.global) ? raw.global : {};
  let migrated = !isRecord(raw.global);
  for (const key of EXECUTION_DEFAULT_KEYS) {
    if (rawGlobal[key] !== undefined && global[key] !== rawGlobal[key]) {
      migrated = true;
    }
  }

  const byAgent: Record<string, Partial<ExecutionDefaults>> = {};
  const rawByAgent = isRecord(raw.byAgent) ? raw.byAgent : {};
  if (!isRecord(raw.byAgent)) migrated = raw.byAgent !== undefined;

  for (const [agentId, value] of Object.entries(rawByAgent)) {
    const normalizedAgentId = optionalString(agentId);
    if (!normalizedAgentId || !isRecord(value)) {
      migrated = true;
      continue;
    }
    const patch = sanitizeExecutionDefaultsPatch(value);
    byAgent[normalizedAgentId] = patch;
    const rawPatch = value as Record<string, unknown>;
    for (const key of EXECUTION_DEFAULT_KEYS) {
      if (rawPatch[key] !== undefined && patch[key] !== rawPatch[key]) {
        migrated = true;
      }
    }
  }

  return {
    defaults: { global, byAgent },
    migrated,
  };
}

export function dedupeRecentAgentSettings(entries: RecentAgentSetting[]): RecentAgentSetting[] {
  const result: RecentAgentSetting[] = [];
  const seen = new Set<string>();
  const countsByExecutor = new Map<string, number>();
  for (const entry of entries) {
    const key = recentAgentSettingKey(entry);
    if (seen.has(key)) continue;
    const executorId = effectiveExecutorId(entry.executorId);
    const count = countsByExecutor.get(executorId) ?? 0;
    if (count >= RECENT_AGENT_SETTINGS_PER_EXECUTOR_LIMIT) continue;
    seen.add(key);
    countsByExecutor.set(executorId, count + 1);
    result.push(entry);
  }
  return result;
}

export function sanitizeRecentAgentSettings(raw: unknown): {
  entries: RecentAgentSetting[];
  migrated: boolean;
} {
  if (!Array.isArray(raw)) return { entries: [], migrated: raw !== undefined };

  const valid: RecentAgentSetting[] = [];
  let migrated = false;
  for (const entry of raw) {
    const recent = sanitizeRecentAgentSetting(entry);
    if (recent) {
      valid.push(recent);
    } else {
      migrated = true;
    }
  }

  const deduped = dedupeRecentAgentSettings(valid);
  if (deduped.length !== valid.length) {
    migrated = true;
  }

  return { entries: deduped, migrated };
}

export function legacyRecentAgentSetting(raw: Record<string, unknown>): RecentAgentSetting | null {
  return sanitizeRecentAgentSetting({
    agentId: raw.lastAgentId,
    model: raw.lastModel,
    apiProviderId: raw.lastApiProviderId,
    modelEndpointId: raw.lastModelEndpointId,
    modelProtocol: raw.lastModelProtocol,
  });
}

export function legacyExecutionDefaults(raw: Record<string, unknown>): ExecutionDefaults {
  return sanitizeExecutionDefaults({
    permissionMode: raw.lastPermissionMode,
    thinkingMode: raw.lastThinkingMode,
    agentSettingsById: {},
  });
}

export function sanitizePathSettings(raw: Record<string, unknown>): {
  paths: PathSettings;
  migrated: boolean;
} {
  const rawPaths = isRecord(raw.paths) ? raw.paths : {};
  const legacyProjectPath = optionalPath(raw.lastProjectPath);
  const normalizedPaths = normalizePathSettings(rawPaths);
  const pinnedProjectPaths = orderedProjectPaths(normalizedPaths.pinnedProjectPaths);
  const current = orderedProjectPaths(normalizedPaths.recentProjectPaths);
  const recentProjectPaths = orderedProjectPaths(
    [...current, ...(legacyProjectPath ? [legacyProjectPath] : [])],
  );
  const paths = {
    ...normalizedPaths,
    ...(Array.isArray(rawPaths.pinnedProjectPaths) ? { pinnedProjectPaths } : {}),
    recentProjectPaths,
  };
  const migrated =
    Boolean(legacyProjectPath) ||
    (Array.isArray(rawPaths.pinnedProjectPaths) &&
      !sameStringArray(rawPaths.pinnedProjectPaths, pinnedProjectPaths)) ||
    JSON.stringify(rawPaths.byExecutor) !== JSON.stringify(normalizedPaths.byExecutor) ||
    !Array.isArray(rawPaths.recentProjectPaths) ||
    !sameStringArray(rawPaths.recentProjectPaths, recentProjectPaths);
  return { paths, migrated };
}

export function recordRecentProjectPath(paths: PathSettings, projectPath: unknown, targetExecutor?: unknown): PathSettings {
  const normalizedPaths = normalizePathSettings(paths);
  const value = optionalPath(projectPath);
  if (!value) return normalizedPaths;
  const executorId = parseExecutorId(targetExecutor);
  if (!executorId) throw new Error('Invalid executor ID');
  if (executorId !== LOCAL_EXECUTOR_ID) {
    if (normalizedPaths.byExecutor !== undefined && !isRecord(normalizedPaths.byExecutor)) {
      throw new Error('Invalid executor project preferences');
    }
    const byExecutor = isRecord(normalizedPaths.byExecutor) ? normalizedPaths.byExecutor : {};
    const validPreferences = readExecutorProjectPreferences(byExecutor);
    if (executorId in byExecutor && !validPreferences[executorId]) {
      throw new Error('Invalid executor project preferences');
    }
    const previous = validPreferences[executorId] ?? { recentPaths: [], pinnedPaths: [] };
    return { ...normalizedPaths, byExecutor: { ...byExecutor, [executorId]: {
      ...previous, recentPaths: orderedProjectPaths([value, ...previous.recentPaths]),
    } } };
  }
  const current = orderedProjectPaths(normalizedPaths.recentProjectPaths);
  return {
    ...normalizedPaths,
    recentProjectPaths: orderedProjectPaths([value, ...current]),
  };
}
