import { describe, expect, test } from 'bun:test';
import {
  AGENT_SWITCH_CONTEXT_WINDOW_TOKEN_CHOICES,
  HANDOFF_CONTEXT_WINDOW_MAX_TOKENS,
  HANDOFF_CONTEXT_WINDOW_MIN_TOKENS,
  isHandoffContextWindowTokens,
  parseAgentSwitchContextWindowTokens,
  usableHandoffTokenBudget,
} from '../handoff-sizing.ts';

describe('handoff sizing', () => {
  test('accepts only the three agent-switch presets', () => {
    for (const value of AGENT_SWITCH_CONTEXT_WINDOW_TOKEN_CHOICES) {
      expect(parseAgentSwitchContextWindowTokens(value)).toBe(value);
    }
    for (const value of ['500000', 500_000.5, 300_000, null, undefined]) {
      expect(parseAgentSwitchContextWindowTokens(value)).toBeNull();
    }
  });

  test('accepts arbitrary safe context windows inside the public bounds', () => {
    for (const value of [1_024, 131_072, 500_000, 10_000_000]) {
      expect(isHandoffContextWindowTokens(value)).toBeTrue();
    }
    for (const value of [
      HANDOFF_CONTEXT_WINDOW_MIN_TOKENS - 1,
      HANDOFF_CONTEXT_WINDOW_MAX_TOKENS + 1,
      500_000.5,
      Number.MAX_SAFE_INTEGER + 1,
      '500000',
      null,
    ]) {
      expect(isHandoffContextWindowTokens(value)).toBeFalse();
    }
  });

  test('reserves exactly one quarter of each preset', () => {
    expect(usableHandoffTokenBudget(200_000)).toBe(150_000);
    expect(usableHandoffTokenBudget(500_000)).toBe(375_000);
    expect(usableHandoffTokenBudget(1_000_000)).toBe(750_000);
  });
});
