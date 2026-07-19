import type { ApiProtocol } from '../../common/api-providers.js';
import {
  DEFAULT_PERMISSION_MODE,
  DEFAULT_THINKING_MODE,
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../common/chat-modes.js';
import { parseAgentSettingsById } from '../../common/agent-integration.js';
import type {
  ExecutionDefaults,
  ExecutionDefaultsSettings,
  PathSettings,
  RecentAgentSetting,
} from './types.js';

export const RECENT_AGENT_SETTINGS_LIMIT = 20;
export const RECENT_PROJECT_PATHS_LIMIT = 10;
const EXECUTION_DEFAULT_KEYS = [
  'permissionMode',
  'thinkingMode',
  'agentSettingsById',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

function normalizeProtocol(value: unknown): ApiProtocol | null {
  if (value === 'openai-compatible' || value === 'anthropic-messages') return value;
  return null;
}

function dedupeStrings(entries: unknown, limit: number): string[] {
  if (!Array.isArray(entries)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const value = optionalString(entry);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function compareStringsAlphabetically(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function sortedPinnedProjectPaths(entries: unknown): string[] {
  return dedupeStrings(entries, Number.MAX_SAFE_INTEGER).sort(compareStringsAlphabetically);
}

function sameStringArray(left: unknown[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function normalizePathSettings(paths: PathSettings): PathSettings {
  if (!Array.isArray(paths.pinnedProjectPaths)) return paths;
  return {
    ...paths,
    pinnedProjectPaths: sortedPinnedProjectPaths(paths.pinnedProjectPaths),
  };
}

export function recentAgentSettingKey(entry: RecentAgentSetting): string {
  return [
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

  return {
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
  for (const entry of entries) {
    const key = recentAgentSettingKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
    if (result.length >= RECENT_AGENT_SETTINGS_LIMIT) break;
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
  if (deduped.length !== valid.length || raw.length > RECENT_AGENT_SETTINGS_LIMIT) {
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
  const legacyProjectPath = optionalString(raw.lastProjectPath);
  const pinnedProjectPaths = sortedPinnedProjectPaths(rawPaths.pinnedProjectPaths);
  const current = dedupeStrings(rawPaths.recentProjectPaths, RECENT_PROJECT_PATHS_LIMIT);
  const recentProjectPaths = dedupeStrings(
    [...current, ...(legacyProjectPath ? [legacyProjectPath] : [])],
    RECENT_PROJECT_PATHS_LIMIT,
  );
  const paths = {
    ...rawPaths,
    ...(Array.isArray(rawPaths.pinnedProjectPaths) ? { pinnedProjectPaths } : {}),
    recentProjectPaths,
  };
  const rawRecentCount = Array.isArray(rawPaths.recentProjectPaths)
    ? rawPaths.recentProjectPaths.length
    : 0;
  const migrated =
    Boolean(legacyProjectPath) ||
    (Array.isArray(rawPaths.pinnedProjectPaths) &&
      !sameStringArray(rawPaths.pinnedProjectPaths, pinnedProjectPaths)) ||
    !Array.isArray(rawPaths.recentProjectPaths) ||
    rawRecentCount !== recentProjectPaths.length;
  return { paths, migrated };
}

export function recordRecentProjectPath(paths: PathSettings, projectPath: unknown): PathSettings {
  const normalizedPaths = normalizePathSettings(paths);
  const value = optionalString(projectPath);
  if (!value) return normalizedPaths;
  const current = dedupeStrings(normalizedPaths.recentProjectPaths, RECENT_PROJECT_PATHS_LIMIT);
  return {
    ...normalizedPaths,
    recentProjectPaths: dedupeStrings([value, ...current], RECENT_PROJECT_PATHS_LIMIT),
  };
}
