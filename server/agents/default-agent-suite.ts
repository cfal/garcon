import type { ApiProviderReader } from '../api-providers/read-model.js';
import { ClaudeCliRuntime } from './claude/claude-cli.js';
import { CodexAppServerRuntime } from './codex/app-server/runtime.js';
import { OpenCodeRuntime } from './opencode/opencode.js';
import { AmpCliRuntime } from './amp/amp-cli.js';
import { FactoryCliRuntime } from './factory/factory-cli.js';
import { createAmpAgent } from './amp/index.js';
import { createClaudeAgent } from './claude/index.js';
import { createCodexAgent } from './codex/index.js';
import { createCursorAgent } from './cursor/index.js';
import { createDirectAnthropicAgent } from './direct/anthropic.js';
import { createDirectOpenAiChatAgent } from './direct/openai-chat.js';
import { createDirectOpenAiResponsesAgent } from './direct/openai-responses.js';
import { createFactoryAgent } from './factory/index.js';
import { createOpenCodeAgent } from './opencode/index.js';
import { createPiAgent } from './pi/index.js';
import { LazyPiRuntime } from './pi/lazy-runtime.js';
import type { Agent } from './types.js';
import type { AgentId } from '../../common/agents.js';

export interface DefaultAgentSuiteOptions {
  workspaceDir: string;
  apiProviderReader: ApiProviderReader;
}

export interface AgentModuleContext extends DefaultAgentSuiteOptions {
  codexAppServerRuntime?: CodexAppServerRuntime;
}

export interface AgentModule {
  id: AgentId;
  createAgent(context: AgentModuleContext): Agent;
}

export interface DefaultAgentSuite {
  agents: Agent[];
  codexAppServerRuntime: CodexAppServerRuntime;
}

export const coreAgentModules = [
  {
    id: 'claude',
    createAgent: () => createClaudeAgent(new ClaudeCliRuntime()),
  },
  {
    id: 'codex',
    createAgent: (context) => createCodexAgent(context.codexAppServerRuntime ?? new CodexAppServerRuntime()),
  },
] satisfies readonly AgentModule[];

export const integratedAgentModules = [
  {
    id: 'direct-openai-responses-compatible',
    createAgent: (context) => createDirectOpenAiResponsesAgent(
      context.apiProviderReader,
      context.workspaceDir,
    ),
  },
  {
    id: 'direct-openai-compatible',
    createAgent: (context) => createDirectOpenAiChatAgent(
      context.apiProviderReader,
      context.workspaceDir,
    ),
  },
  {
    id: 'direct-anthropic-compatible',
    createAgent: (context) => createDirectAnthropicAgent(
      context.apiProviderReader,
      context.workspaceDir,
    ),
  },
  {
    id: 'opencode',
    createAgent: () => createOpenCodeAgent(new OpenCodeRuntime()),
  },
  {
    id: 'amp',
    createAgent: () => createAmpAgent(new AmpCliRuntime()),
  },
  {
    id: 'cursor',
    createAgent: (context) => createCursorAgent({ workspaceDir: context.workspaceDir }),
  },
  {
    id: 'factory',
    createAgent: () => createFactoryAgent(new FactoryCliRuntime()),
  },
  {
    id: 'pi',
    createAgent: () => createPiAgent(new LazyPiRuntime()),
  },
] satisfies readonly AgentModule[];

export const defaultAgentModules = [
  ...coreAgentModules,
  ...integratedAgentModules,
] satisfies readonly AgentModule[];

export function createDefaultAgents(
  context: AgentModuleContext,
): Agent[] {
  return defaultAgentModules.map((module) => module.createAgent(context));
}

export function createDefaultAgentSuite(options: DefaultAgentSuiteOptions): DefaultAgentSuite {
  const codexAppServerRuntime = new CodexAppServerRuntime();
  const context: AgentModuleContext = {
    ...options,
    codexAppServerRuntime,
  };

  return {
    codexAppServerRuntime,
    agents: createDefaultAgents(context),
  };
}
