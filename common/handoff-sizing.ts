export const AGENT_SWITCH_CONTEXT_WINDOW_TOKEN_CHOICES = [
  200_000,
  500_000,
  1_000_000,
] as const;

export type AgentSwitchContextWindowTokens =
  (typeof AGENT_SWITCH_CONTEXT_WINDOW_TOKEN_CHOICES)[number];

export const DEFAULT_HANDOFF_CONTEXT_WINDOW_TOKENS:
  AgentSwitchContextWindowTokens = 500_000;

export const HANDOFF_CONTEXT_WINDOW_MIN_TOKENS = 1_024;
export const HANDOFF_CONTEXT_WINDOW_MAX_TOKENS = 10_000_000;
export const SMALL_HISTORY_NO_COMPACTION_MAX_ESTIMATED_TOKENS = 100_000;

const USABLE_WINDOW_NUMERATOR = 3;
const USABLE_WINDOW_DENOMINATOR = 4;

export function usableHandoffTokenBudget(contextWindowTokens: number): number {
  return Math.floor(
    contextWindowTokens * USABLE_WINDOW_NUMERATOR / USABLE_WINDOW_DENOMINATOR,
  );
}

export function parseAgentSwitchContextWindowTokens(
  value: unknown,
): AgentSwitchContextWindowTokens | null {
  return typeof value === 'number'
    && AGENT_SWITCH_CONTEXT_WINDOW_TOKEN_CHOICES.includes(
      value as AgentSwitchContextWindowTokens,
    )
    ? value as AgentSwitchContextWindowTokens
    : null;
}

export function isHandoffContextWindowTokens(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= HANDOFF_CONTEXT_WINDOW_MIN_TOKENS
    && value <= HANDOFF_CONTEXT_WINDOW_MAX_TOKENS;
}
