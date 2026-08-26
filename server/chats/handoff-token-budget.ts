import { estimateTokenCount } from 'tokenx';
import { usableHandoffTokenBudget } from '../../common/handoff-sizing.js';

export interface EstimatedTokenBudget {
  readonly contextWindowTokens: number;
  readonly usableTokens: number;
}

export const COMPACTION_QUERY_ATTEMPTS = 2;
const COMPACTION_RETRY_NUMERATOR = 7;
const COMPACTION_RETRY_DENOMINATOR = 10;
const FIT_CORRECTION_MAX_PASSES = 8;
const FIT_CONVERGENCE_GUARD_TOKENS = 8;

export function estimateHandoffTokens(text: string): number {
  return estimateTokenCount(text);
}

export function handoffTokenBudget(contextWindowTokens: number): EstimatedTokenBudget {
  return {
    contextWindowTokens,
    usableTokens: usableHandoffTokenBudget(contextWindowTokens),
  };
}

export function reducedCompactionEntryBudget(firstEntryBudgetTokens: number): number {
  return Math.floor(
    firstEntryBudgetTokens
      * COMPACTION_RETRY_NUMERATOR
      / COMPACTION_RETRY_DENOMINATOR,
  );
}

export function fitEstimatedTokenDocument<T>(input: {
  readonly usableTokens: number;
  readonly fixedFrameTokens: number;
  readonly maximumEntryBudgetTokens?: number;
  readonly render: (entryBudgetTokens: number) => T | null;
  readonly document: (value: T) => string;
  readonly minimumEntryBudgetTokens?: number;
}): {
  readonly value: T;
  readonly estimatedTokens: number;
  readonly entryBudgetTokens: number;
} | null {
  const minimumEntryBudget = input.minimumEntryBudgetTokens ?? 1;
  const availableEntryBudget = input.usableTokens - input.fixedFrameTokens;
  let entryBudget = Math.min(
    availableEntryBudget,
    input.maximumEntryBudgetTokens ?? availableEntryBudget,
  );
  if (entryBudget < minimumEntryBudget) return null;

  for (let attempt = 0; attempt < FIT_CORRECTION_MAX_PASSES; attempt += 1) {
    const value = input.render(entryBudget);
    if (value === null) return null;
    const estimatedTokens = estimateHandoffTokens(input.document(value));
    if (estimatedTokens <= input.usableTokens) {
      return { value, estimatedTokens, entryBudgetTokens: entryBudget };
    }
    entryBudget -= estimatedTokens - input.usableTokens + FIT_CONVERGENCE_GUARD_TOKENS;
    if (entryBudget < minimumEntryBudget) return null;
  }
  return null;
}
