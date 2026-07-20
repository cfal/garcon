import { describe, expect, it } from 'bun:test';
import { defaultAgentIntegrations } from '../default-agent-integrations.ts';

describe('default agent integrations', () => {
  it('registers every shipped integration exactly once in product order', () => {
    expect(defaultAgentIntegrations.map((integration) => integration.integrationId)).toEqual([
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
    expect(new Set(defaultAgentIntegrations).size).toBe(defaultAgentIntegrations.length);
  });

  it('uses the supported integration API version for every package', () => {
    expect(defaultAgentIntegrations.every((integration) => integration.apiVersion === 2)).toBe(true);
    expect(defaultAgentIntegrations.every((integration) => integration.transcriptIndex.apiVersion === 1)).toBe(true);
  });
});
