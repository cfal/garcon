import {
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL,
} from '@garcon/common/agents';
import type { ApiProviderReader } from '@garcon/server-agent-common/legacy/api-providers';
import { createAgentCapabilities } from '@garcon/server-agent-common/legacy/capabilities';
import type { Agent } from '@garcon/server-agent-common/legacy/types';
import { createDirectOpenAiChatRuntime } from '@garcon/server-agent-common/direct/router';
import { createDirectSessionPaths } from '@garcon/server-agent-common/direct/session-paths';
import { createDirectCompatibleTranscriptSource } from '@garcon/server-agent-common/direct/transcript-source';

const NO_AUTH_STATUS = {
  authenticated: false,
  canReauth: false,
  label: '',
  source: 'none',
};

export function createDirectOpenAiChatAgent(
  apiProviders: ApiProviderReader,
  workspaceDir: string,
): Agent {
  const sessionPaths = createDirectSessionPaths(
    workspaceDir,
    DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  );
  const runtime = createDirectOpenAiChatRuntime(apiProviders, sessionPaths);
  return {
    id: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
    label: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL,
    runtime,
    transcript: createDirectCompatibleTranscriptSource({
      agentId: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
      protocol: 'openai-compatible',
      sessionLabel: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL,
      apiProviders,
      getSessionFilePath: sessionPaths.sessionFilePath,
    }),
    auth: { async getAuthStatus() { return NO_AUTH_STATUS; } },
    capabilities: createAgentCapabilities({
      supportsFork: true,
      supportsForkAtMessage: true,
      supportsForkWhileRunning: false,
      supportsUpdateProjectPath: true,
      supportsImages: true,
      acceptsApiProviderEndpoints: true,
      supportedProtocols: ['openai-compatible'],
      authLoginSupported: false,
      getModels: () => runtime.getModels(),
    }),
    runSingleQuery(prompt, options) {
      return runtime.runSingleQuery(prompt, options);
    },
  };
}
