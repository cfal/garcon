import { describe, expect, it } from 'bun:test';
import {
  executionDefaultsForAgent,
  isThinkingModeSupported,
  normalizeSupportedPermissionMode,
  normalizeSupportedThinkingMode,
} from '../execution-defaults.js';

describe('execution defaults', () => {
  it('merges one agent override onto global defaults', () => {
    const globalSettings = { ownerId: 'codex', schemaVersion: 1, values: { source: 'global' } };
    const agentSettings = { ownerId: 'codex', schemaVersion: 1, values: { source: 'agent' } };
    expect(executionDefaultsForAgent({
      global: {
        permissionMode: 'default',
        thinkingMode: 'low',
        agentSettingsById: { codex: globalSettings },
      },
      byAgent: {
        codex: {
          permissionMode: 'acceptEdits',
          agentSettingsById: { codex: agentSettings },
        },
      },
    }, 'codex')).toEqual({
      permissionMode: 'acceptEdits',
      thinkingMode: 'low',
      agentSettingsById: { codex: agentSettings },
    });
  });

  it('falls back to canonical modes without configured defaults', () => {
    expect(executionDefaultsForAgent(null, 'codex')).toEqual({
      permissionMode: 'default',
      thinkingMode: 'none',
      agentSettingsById: {},
    });
  });

  it('selects the first supported mode when a configured mode is unavailable', () => {
    expect(normalizeSupportedPermissionMode('plan', ['default', 'acceptEdits'])).toBe('default');
    expect(normalizeSupportedThinkingMode('ultra', ['low', 'high'])).toBe('low');
  });

  it('accepts only the neutral value when reasoning mode is not configurable', () => {
    expect(isThinkingModeSupported('none', [])).toBe(true);
    expect(isThinkingModeSupported('high', [])).toBe(false);
    expect(isThinkingModeSupported('high', ['none', 'high'])).toBe(true);
  });
});
