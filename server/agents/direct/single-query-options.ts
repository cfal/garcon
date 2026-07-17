import { normalizeThinkingMode, type ThinkingMode } from '../../../common/chat-modes.js';

export const DEFAULT_DIRECT_SINGLE_QUERY_TIMEOUT_MS = 30_000;
export const MAX_DIRECT_SINGLE_QUERY_TIMEOUT_MS = 120_000;

export function directSingleQueryTimeoutMs(options: Record<string, unknown>): number {
  const value = options.timeoutMs;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_DIRECT_SINGLE_QUERY_TIMEOUT_MS;
  }
  return Math.min(MAX_DIRECT_SINGLE_QUERY_TIMEOUT_MS, Math.max(1_000, Math.round(value)));
}

export function directSingleQuerySignal(
  options: Record<string, unknown>,
  localSignal: AbortSignal,
): AbortSignal {
  return options.signal instanceof AbortSignal
    ? AbortSignal.any([options.signal, localSignal])
    : localSignal;
}

export function directSingleQueryEffort(
  options: Record<string, unknown>,
): Exclude<ThinkingMode, 'none'> | undefined {
  const effort = normalizeThinkingMode(options.thinkingMode);
  return effort === 'none' ? undefined : effort;
}
