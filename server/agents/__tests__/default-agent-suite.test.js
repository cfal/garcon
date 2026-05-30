import { describe, expect, it } from 'bun:test';
import { defaultAgentModules } from '../default-agent-suite.ts';

describe('default agent suite', () => {
  it('keeps all shipped agents enabled by default', () => {
    expect(defaultAgentModules.map((module) => module.id)).toEqual([
      'claude',
      'codex',
      'direct-openai-responses-compatible',
      'direct-openai-compatible',
      'direct-anthropic-compatible',
      'opencode',
      'amp',
      'cursor',
      'factory',
      'pi',
    ]);
  });
});
