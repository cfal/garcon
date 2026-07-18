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
    expect(agent.capabilities.supportsForkAtMessage).toBe(false);
    expect(agent.capabilities.supportsUpdateProjectPath).toBe(true);
    expect(agent.forkSession).toBeDefined();
  });

  it('advertises OpenCode full-session fork support through the default suite', () => {
    const suite = defaultAgentModules.find((module) => module.id === 'opencode');
    const agent = suite.createAgent({
      workspaceDir: '/tmp/project',
      apiProviderReader: {},
    });

    expect(agent.capabilities.supportsFork).toBe(true);
    expect(agent.capabilities.supportsForkAtMessage).toBe(false);
    expect(agent.capabilities.supportsForkWhileRunning).toBe(false);
    expect(agent.forkSession).toBeDefined();
  });

  it('advertises idle fork and project-path support for every Direct agent', () => {
    const apiProviderReader = {
      list: () => [],
      getEndpoint: () => null,
    };

    for (const id of [
      'direct-openai-compatible',
      'direct-openai-responses-compatible',
      'direct-anthropic-compatible',
    ]) {
      const module = defaultAgentModules.find((entry) => entry.id === id);
      const agent = module.createAgent({
        workspaceDir: '/tmp/project',
        apiProviderReader,
      });

      expect(agent.capabilities).toMatchObject({
        supportsFork: true,
        supportsForkAtMessage: true,
        supportsForkWhileRunning: false,
        supportsUpdateProjectPath: true,
        requiresNativePathForProjectPathUpdate: false,
      });
    }
  });
});
