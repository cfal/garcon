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
  readonly admittedEntryCost?: (value: T) => number;
  readonly minimumEntryBudgetTokens?: number;
}): {
  readonly value: T;
  readonly estimatedTokens: number;
  readonly entryBudgetTokens: number;
  readonly correctionPasses: number;
} | null {
  const minimumEntryBudget = input.minimumEntryBudgetTokens ?? 1;
  const availableEntryBudget = input.usableTokens - input.fixedFrameTokens;
  let entryBudget = Math.min(
    availableEntryBudget,
    input.maximumEntryBudgetTokens ?? availableEntryBudget,
  );
  if (entryBudget < minimumEntryBudget) return null;

  let correctionPasses = 0;
  let forcedAttemptPending = false;
  let minimumBridgeAttempted = false;
  let minimumBridgePending = false;
  while (correctionPasses < FIT_CORRECTION_MAX_PASSES || forcedAttemptPending) {
    const renderedAtMinimumBridge = minimumBridgePending;
    forcedAttemptPending = false;
    minimumBridgePending = false;
    const value = input.render(entryBudget);
    if (value === null) return null;
    correctionPasses += 1;
    const renderedAtMinimum = entryBudget === minimumEntryBudget;
    const estimatedTokens = estimateHandoffTokens(input.document(value));
    if (estimatedTokens <= input.usableTokens) {
      return {
        value,
        estimatedTokens,
        entryBudgetTokens: entryBudget,
        correctionPasses,
      };
    }
    if (renderedAtMinimum) return null;
    if (renderedAtMinimumBridge) {
      entryBudget = minimumEntryBudget;
      forcedAttemptPending = true;
      continue;
    }
    const overflowCorrection = entryBudget
      - (estimatedTokens - input.usableTokens + FIT_CONVERGENCE_GUARD_TOKENS);
    const admittedCost = input.admittedEntryCost?.(value);
    // Crossing the prior selection's admission threshold guarantees that a
    // whole-entry selector cannot return the same oversized document again.
    const correctedEntryBudget = admittedCost === undefined
      ? overflowCorrection
      : Math.min(overflowCorrection, Math.ceil(admittedCost) - 1);
    if (correctedEntryBudget <= minimumEntryBudget && !minimumBridgeAttempted) {
      // Uses one damped render before an overshooting correction collapses to
      // the minimum, while crossing the prior selection's admission threshold.
      const dampedEntryBudget = Math.min(
        Math.floor((entryBudget + minimumEntryBudget) / 2),
        admittedCost === undefined ? entryBudget - 1 : Math.ceil(admittedCost) - 1,
      );
      if (dampedEntryBudget > minimumEntryBudget) {
        entryBudget = dampedEntryBudget;
        minimumBridgeAttempted = true;
        minimumBridgePending = true;
        forcedAttemptPending = true;
        continue;
      }
    }
    entryBudget = Math.max(minimumEntryBudget, correctedEntryBudget);
    forcedAttemptPending = entryBudget === minimumEntryBudget;
  }
  return null;
}
