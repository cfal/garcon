import { describe, expect, test } from 'bun:test';
import {
  COMPACTION_QUERY_ATTEMPTS,
  estimateHandoffTokens,
  fitEstimatedTokenDocument,
  handoffTokenBudget,
  reducedCompactionEntryBudget,
} from '../handoff-token-budget.ts';

describe('handoff token budget', () => {
  test('wraps deterministic tokenx estimation for representative text', () => {
    for (const value of [
      '',
      'plain English and XML <user>content</user>',
      'const value = answer?.items.map((item) => item.id);',
      '中文、日本語、한국어',
      '🙂🚀',
      '\uD800 malformed surrogate',
    ]) {
      const estimate = estimateHandoffTokens(value);
      expect(Number.isSafeInteger(estimate)).toBeTrue();
      expect(estimate).toBeGreaterThanOrEqual(0);
      expect(estimateHandoffTokens(value)).toBe(estimate);
    }
  });

  test('reports fixed query and retry policy', () => {
    expect(COMPACTION_QUERY_ATTEMPTS).toBe(2);
    expect(reducedCompactionEntryBudget(10)).toBe(7);
    expect(reducedCompactionEntryBudget(11)).toBe(7);
    expect(reducedCompactionEntryBudget(101)).toBe(70);
    expect(handoffTokenBudget(500_000)).toEqual({
      contextWindowTokens: 500_000,
      usableTokens: 375_000,
    });
  });

  test('corrects a complete document that exceeds the additive entry budget', () => {
    const seen = [];
    const result = fitEstimatedTokenDocument({
      usableTokens: 30,
      fixedFrameTokens: 2,
      render(entryBudgetTokens) {
        seen.push(entryBudgetTokens);
        return 'word '.repeat(entryBudgetTokens + 10);
      },
      document: (value) => `<frame>${value}</frame>`,
    });

    expect(seen.length).toBeGreaterThan(1);
    expect(result).not.toBeNull();
    expect(result.entryBudgetTokens).toBe(seen.at(-1));
    expect(result.estimatedTokens).toBeLessThanOrEqual(30);
  });

  test('honors an explicit maximum and rejects a frame with no entry room', () => {
    const result = fitEstimatedTokenDocument({
      usableTokens: 100,
      fixedFrameTokens: 10,
      maximumEntryBudgetTokens: 20,
      render: (entryBudgetTokens) => `entry-${entryBudgetTokens}`,
      document: (value) => value,
    });
    expect(result.entryBudgetTokens).toBe(20);

    expect(fitEstimatedTokenDocument({
      usableTokens: 10,
      fixedFrameTokens: 10,
      render: () => 'unreachable',
      document: (value) => value,
    })).toBeNull();
  });
});
