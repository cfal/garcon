import type { UsageCategoryCost } from '@garcon/common/usage';
import { MODEL_PRICES, type ModelPrice } from './model-prices.js';
import type { UsageRecord } from './usage-record.js';

export interface PricedUsage {
  readonly costUsd: number;
  readonly categoryCostUsd: UsageCategoryCost;
  readonly cacheSavingsUsd: number;
}

const resolvedPrices = new Map<string, ModelPrice | null>();

/**
 * Maps a transcript model name to its price-table key: provider prefixes,
 * Bedrock version suffixes, context-window variants such as `[1m]`, and
 * snapshot dates are dropped, and dotted Claude versions use dashes.
 */
export function priceTableKey(model: string): string {
  let key = model.trim().toLowerCase();
  key = key.slice(key.lastIndexOf('/') + 1);
  const bracket = key.indexOf('[');
  if (bracket !== -1) key = key.slice(0, bracket);
  const vendor = key.indexOf('anthropic.');
  if (vendor !== -1) key = key.slice(vendor + 'anthropic.'.length);
  key = key.replace(/-v\d+(?::\d+)?$/u, '').replace(/-\d{8}$/u, '').replace(/-\d{4}-\d{2}-\d{2}$/u, '');
  if (key.startsWith('claude-')) key = key.replace(/(\d)\.(\d)/gu, '$1-$2');
  return key;
}

export function lookupModelPrice(model: string): ModelPrice | null {
  let price = resolvedPrices.get(model);
  if (price === undefined) {
    price = MODEL_PRICES.get(priceTableKey(model)) ?? null;
    if (resolvedPrices.size >= 1024) resolvedPrices.clear();
    resolvedPrices.set(model, price);
  }
  return price;
}

/** Returns null for models without a known price. Reasoning tokens are already part of output. */
export function priceUsageRecord(record: Pick<UsageRecord, 'model' | 'totals' | 'cacheWrite1hTokens' | 'speed'>): PricedUsage | null {
  const price = lookupModelPrice(record.model);
  if (!price) return null;
  const { uncachedInputTokens, cachedInputTokens, cacheWriteTokens, outputTokens } = record.totals;
  const promptTokens = uncachedInputTokens + cachedInputTokens + cacheWriteTokens;
  const rates = price.longContext && promptTokens > price.longContext.promptTokensAbove
    ? price.longContext.rates
    : price.rates;
  const tier = record.speed === 'fast' ? price.fastMultiplier : record.speed === 'flex' ? price.flexMultiplier : null;
  // A tier the table does not price for this model bills at standard rates.
  const scale = (tier ?? 1) / 1_000_000;
  const write1h = Math.min(record.cacheWrite1hTokens, cacheWriteTokens);
  const categoryCostUsd = {
    input: uncachedInputTokens * rates.input * scale,
    cacheRead: cachedInputTokens * rates.cacheRead * scale,
    cacheWrite: ((cacheWriteTokens - write1h) * rates.cacheWrite + write1h * rates.cacheWrite1h) * scale,
    output: outputTokens * rates.output * scale,
  };
  return {
    costUsd: categoryCostUsd.input + categoryCostUsd.cacheRead + categoryCostUsd.cacheWrite + categoryCostUsd.output,
    categoryCostUsd,
    cacheSavingsUsd: cachedInputTokens * (rates.input - rates.cacheRead) * scale,
  };
}
