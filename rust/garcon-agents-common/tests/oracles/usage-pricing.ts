import { MODEL_PRICES } from '../../../../server-agents/common/src/usage/model-prices.ts';

export function modelPrices() {
  return Object.fromEntries(MODEL_PRICES);
}

export function isTypedUsageRecord(value: unknown) {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.timestampMs === 'number' && Number.isSafeInteger(record.timestampMs)
    && ['standard', 'fast', 'ultrafast', 'flex', 'unknown'].includes(String(record.speed))
    && typeof record.model === 'string' && typeof record.sessionId === 'string'
    && (typeof record.dedupeKey === 'string' || record.dedupeKey === null)
    && typeof record.cacheWrite1hTokens === 'number' && record.totals !== null
    && typeof record.totals === 'object'
    && ['uncachedInputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens']
      .every((key) => typeof (record.totals as Record<string, unknown>)[key] === 'number');
}
