import { describe, expect, test } from 'bun:test';
import { MODEL_PRICES } from '../model-prices.js';
import { lookupModelPrice, priceTableKey, priceUsageRecord } from '../usage-pricing.js';
import type { UsageRecord } from '../usage-record.js';

function record(model: string, totals: Partial<UsageRecord['totals']>, extra: Partial<UsageRecord> = {}): UsageRecord {
  return {
    timestampMs: 0,
    model,
    sessionId: 'session',
    totals: { uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, ...totals },
    cacheWrite1hTokens: 0,
    speed: 'standard',
    dedupeKey: null,
    ...extra,
  };
}

describe('price table keys', () => {
  test('drop provider prefixes, snapshot dates, context variants, and Bedrock versions', () => {
    expect(priceTableKey('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(priceTableKey('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(priceTableKey('anthropic/claude-opus-4.6')).toBe('claude-opus-4-6');
    expect(priceTableKey('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5');
    expect(priceTableKey('openai/GPT-5.4-2026-03-05')).toBe('gpt-5.4');
    expect(priceTableKey('gpt-6.1-terra')).toBe('gpt-6.1-terra');
  });

  test('leave unknown and family-only names unpriced', () => {
    expect(lookupModelPrice('opus')).toBeNull();
    expect(lookupModelPrice('gpt-5.3-codex-spark')).toBeNull();
    expect(priceUsageRecord(record('<synthetic>', { outputTokens: 10 }))).toBeNull();
  });

  test('leaves Ultrafast unpriced on a model without an Ultrafast rate', () => {
    expect(priceUsageRecord(record('gpt-5.6-sol', { outputTokens: 1_000_000 }, { speed: 'ultrafast' }))).toBeNull();
  });

  test('every entry has finite, non-negative rates', () => {
    for (const [model, price] of MODEL_PRICES) {
      const tiers = [price.rates, ...(price.longContext ? [price.longContext.rates] : [])];
      for (const rates of tiers) {
        for (const value of Object.values(rates)) {
          expect(Number.isFinite(value) && value >= 0, model).toBe(true);
        }
        expect(rates.cacheRead, model).toBeLessThanOrEqual(rates.input);
      }
    }
  });
});

describe('pricing', () => {
  test.each([
    ['gpt-6.2-astra', 8, 40, 0.4, 10],
    ['gpt-6.2-sol', 2, 10, 0.1, 2.5],
    ['gpt-6-astra', 10, 50, 1, 12.5],
    ['gpt-6.1-sol', 2, 10, 0.1, 2.5],
  ] as const)('prices every Ultrafast token category and cache savings for %s', (model, input, output, cached, write) => {
    for (const promptTokens of [272_000, 272_001]) {
      const long = promptTokens > 272_000;
      const priced = priceUsageRecord(record(model, {
        uncachedInputTokens: promptTokens - 200_000, cachedInputTokens: 100_000,
        cacheWriteTokens: 100_000, outputTokens: 1_000_000, reasoningTokens: 200_000,
      }, { speed: 'ultrafast', cacheWrite1hTokens: 40_000 }))!;
      const promptMultiplier = 6 * (long ? 2 : 1);
      const categories = {
        input: (promptTokens - 200_000) / 1_000_000 * input * promptMultiplier,
        cacheRead: 0.1 * cached * promptMultiplier,
        cacheWrite: 0.1 * write * promptMultiplier,
        output: output * 6 * (long ? 1.5 : 1),
      };
      for (const [category, cost] of Object.entries(categories)) {
        expect(priced.categoryCostUsd[category as keyof typeof categories]).toBeCloseTo(cost, 10);
      }
      expect(priced.costUsd).toBeCloseTo(Object.values(categories).reduce((sum, cost) => sum + cost, 0), 10);
      expect(priced.cacheSavingsUsd).toBeCloseTo(0.1 * (input - cached) * promptMultiplier, 10);
    }
  });

  test.each(['2026-11-20T00:00:00Z', '2030-01-01T00:00:00Z'])(
    'uses regular Ultrafast rates regardless of the usage date: %s', (timestamp) => {
      for (const [model, outputCost] of [['gpt-6.2-astra', 240], ['gpt-6.2-sol', 60]] as const) {
        const priced = priceUsageRecord(record(model, { outputTokens: 1_000_000 }, {
          speed: 'ultrafast', timestampMs: Date.parse(timestamp),
        }));
        expect(priced?.costUsd).toBe(outputCost);
      }
    },
  );

  test('keeps a response with ambiguous speed unpriced even for a known model', () => {
    expect(priceUsageRecord(record('gpt-6.2-sol', { outputTokens: 100 }, { speed: 'unknown' }))).toBeNull();
  });

  test('bills each Claude token type at its own rate, including one-hour cache writes', () => {
    // Opus 5.5 has no long-context tier, so a 3M-token prompt stays at standard rates.
    const priced = priceUsageRecord(record('claude-opus-5-5', {
      uncachedInputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, { cacheWrite1hTokens: 400_000 }));
    expect(priced?.categoryCostUsd.input).toBeCloseTo(4, 10);
    expect(priced?.categoryCostUsd.cacheRead).toBeCloseTo(0.2, 10);
    expect(priced?.categoryCostUsd.cacheWrite).toBeCloseTo(0.6 * 5 + 0.4 * 8, 10);
    expect(priced?.categoryCostUsd.output).toBeCloseTo(20, 10);
    expect(priced?.costUsd).toBeCloseTo(4 + 0.2 + 6.2 + 20, 10);
    expect(priced?.cacheSavingsUsd).toBeCloseTo(3.8, 10);
  });

  test('applies the fast multiplier only to models that offer it', () => {
    const totals = { uncachedInputTokens: 100_000, outputTokens: 1_000_000 };
    expect(priceUsageRecord(record('claude-opus-5-5', totals, { speed: 'fast' }))?.costUsd).toBeCloseTo((0.4 + 20) * 2, 10);
    expect(priceUsageRecord(record('gpt-5.5', totals, { speed: 'fast' }))?.costUsd).toBeCloseTo((0.5 + 30) * 2.5, 10);
    expect(priceUsageRecord(record('claude-sonnet-5-5', totals, { speed: 'fast' }))?.costUsd).toBeCloseTo(0.2 + 10, 10);
  });

  test('applies the flex discount only to models that offer it', () => {
    const totals = { uncachedInputTokens: 100_000, outputTokens: 1_000_000 };
    expect(priceUsageRecord(record('gpt-6.1-terra', totals, { speed: 'flex' }))?.costUsd).toBeCloseTo((0.1 + 5) * 0.5, 10);
    expect(priceUsageRecord(record('gpt-5.3-codex', totals, { speed: 'flex' }))?.costUsd).toBeCloseTo(0.175 + 14, 10);
  });

  test('switches to long-context rates once the whole prompt crosses the threshold', () => {
    const short = priceUsageRecord(record('claude-haiku-5-5', { uncachedInputTokens: 10, cachedInputTokens: 99_990, outputTokens: 1_000_000 }));
    const long = priceUsageRecord(record('claude-haiku-5-5', { uncachedInputTokens: 11, cachedInputTokens: 99_990, outputTokens: 1_000_000 }));
    expect(short?.categoryCostUsd.output).toBeCloseTo(0.5, 10);
    expect(long?.categoryCostUsd.output).toBeCloseTo(2.5, 10);

    const codex = priceUsageRecord(record('gpt-6-sol', { uncachedInputTokens: 272_001, outputTokens: 1_000_000 }));
    expect(codex?.categoryCostUsd.input).toBeCloseTo(272_001 * 4 / 1_000_000, 10);
    expect(codex?.categoryCostUsd.output).toBeCloseTo(15, 10);
  });

  test('bills OpenAI cache writes at input price unless the model lists a write rate', () => {
    expect(priceUsageRecord(record('gpt-5.4', { cacheWriteTokens: 100_000 }))?.categoryCostUsd.cacheWrite).toBeCloseTo(0.25, 10);
    expect(priceUsageRecord(record('gpt-6-astra', { cacheWriteTokens: 100_000 }))?.categoryCostUsd.cacheWrite).toBeCloseTo(1.25, 10);
  });
});
