import type { ApiProviderReader } from '../api-providers/read-model.js';
import { ClaudeProvider } from './claude/claude-cli.js';
import { CodexAppServerProvider } from './codex/app-server/provider.js';
import { OpenCodeProvider } from './opencode/opencode.js';
import { AmpProvider } from './amp/amp-cli.js';
import { FactoryProvider } from './factory/factory-cli.js';
import { PiProvider } from './pi/pi-cli.js';
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
import type { Agent } from './types.js';

export interface DefaultAgentSuiteOptions {
  workspaceDir: string;
  apiProviderReader: ApiProviderReader;
}

export interface DefaultAgentSuite {
  agents: Agent[];
  codexAppServerProvider: CodexAppServerProvider;
}

export function createDefaultAgentSuite(options: DefaultAgentSuiteOptions): DefaultAgentSuite {
  const claudeProvider = new ClaudeProvider();
  const codexAppServerProvider = new CodexAppServerProvider();
  const opencodeProvider = new OpenCodeProvider();
  const ampProvider = new AmpProvider();
  const factoryProvider = new FactoryProvider();
  const piProvider = new PiProvider();

  return {
    codexAppServerProvider,
    agents: [
      createClaudeAgent(claudeProvider),
      createCodexAgent(codexAppServerProvider),
      createDirectOpenAiResponsesAgent(options.apiProviderReader),
      createDirectOpenAiChatAgent(options.apiProviderReader),
      createDirectAnthropicAgent(options.apiProviderReader),
      createOpenCodeAgent(opencodeProvider),
      createAmpAgent(ampProvider),
      createCursorAgent({ workspaceDir: options.workspaceDir }),
      createFactoryAgent(factoryProvider),
      createPiAgent(piProvider),
    ],
  };
}
