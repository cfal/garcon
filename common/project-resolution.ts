import { parseChatId } from './chat-id.js';
import { isRecord } from './json.js';

export type ProjectTarget =
  | { readonly kind: 'chat'; readonly chatId: string; readonly projectPath: string }
  | { readonly kind: 'path'; readonly projectPath: string };

export const PROJECT_UNAVAILABLE_REASONS = [
  'not-found',
  'not-a-directory',
  'outside-base',
  'permission-denied',
] as const;

export type ProjectUnavailableReason = (typeof PROJECT_UNAVAILABLE_REASONS)[number];

export type ProjectResolution =
  | { readonly kind: 'available'; readonly effectiveProjectKey: string }
  | { readonly kind: 'unavailable'; readonly reason: ProjectUnavailableReason };

export interface ProjectResolutionResponse {
  readonly target: ProjectTarget;
  readonly resolution: ProjectResolution;
}

export function projectTargetKey(target: ProjectTarget): string {
  return target.kind === 'chat'
    ? JSON.stringify(['chat', target.chatId, target.projectPath])
    : JSON.stringify(['path', target.projectPath]);
}

export function isProjectUnavailableReason(value: unknown): value is ProjectUnavailableReason {
  return typeof value === 'string'
    && PROJECT_UNAVAILABLE_REASONS.some((reason) => reason === value);
}

export function parseProjectResolutionResponse(value: unknown): ProjectResolutionResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, ['target', 'resolution'])) return null;
  const target = parseProjectTarget(value.target);
  const resolution = parseProjectResolution(value.resolution);
  return target && resolution ? { target, resolution } : null;
}

function parseProjectTarget(value: unknown): ProjectTarget | null {
  if (!isRecord(value) || typeof value.projectPath !== 'string' || !value.projectPath.trim()) {
    return null;
  }
  if (value.kind === 'path' && hasExactKeys(value, ['kind', 'projectPath'])) {
    return { kind: 'path', projectPath: value.projectPath };
  }
  if (value.kind !== 'chat' || !hasExactKeys(value, ['kind', 'chatId', 'projectPath'])) return null;
  try {
    return { kind: 'chat', chatId: parseChatId(value.chatId), projectPath: value.projectPath };
  } catch {
    return null;
  }
}

function parseProjectResolution(value: unknown): ProjectResolution | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === 'available'
    && hasExactKeys(value, ['kind', 'effectiveProjectKey'])
    && typeof value.effectiveProjectKey === 'string'
    && value.effectiveProjectKey.trim()
  ) {
    return { kind: 'available', effectiveProjectKey: value.effectiveProjectKey };
  }
  if (
    value.kind === 'unavailable'
    && hasExactKeys(value, ['kind', 'reason'])
    && isProjectUnavailableReason(value.reason)
  ) {
    return { kind: 'unavailable', reason: value.reason };
  }
  return null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
