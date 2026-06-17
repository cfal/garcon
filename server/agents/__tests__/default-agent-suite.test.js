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

  it('advertises Cursor fork support through the default suite', () => {
    const suite = defaultAgentModules.find((module) => module.id === 'cursor');
    const agent = suite.createAgent({
      workspaceDir: '/tmp/project',
      apiProviderReader: {},
    });

    expect(agent.capabilities.supportsFork).toBe(true);
    expect(agent.forkSession).toBeDefined();
  });
});
