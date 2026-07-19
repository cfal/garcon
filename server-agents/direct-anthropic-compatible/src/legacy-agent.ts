import {
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL,
} from '@garcon/common/agents';
import type { ApiProviderReader } from '@garcon/server-agent-common/legacy/api-providers';
import { createAgentCapabilities } from '@garcon/server-agent-common/legacy/capabilities';
import type { Agent } from '@garcon/server-agent-common/legacy/types';
import { createDirectAnthropicRuntime } from '@garcon/server-agent-common/direct/router';
import { createDirectSessionPaths } from '@garcon/server-agent-common/direct/session-paths';
import { createDirectCompatibleTranscriptSource } from '@garcon/server-agent-common/direct/transcript-source';

const NO_AUTH_STATUS = {
  authenticated: false,
  canReauth: false,
  label: '',
  source: 'none',
};

export function createDirectAnthropicAgent(
  apiProviders: ApiProviderReader,
  workspaceDir: string,
): Agent {
  const sessionPaths = createDirectSessionPaths(
    workspaceDir,
    DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  );
  const runtime = createDirectAnthropicRuntime(apiProviders, sessionPaths);
  return {
    id: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
    label: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL,
    runtime,
    transcript: createDirectCompatibleTranscriptSource({
      agentId: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
      protocol: 'anthropic-messages',
      sessionLabel: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL,
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
      supportedProtocols: ['anthropic-messages'],
      authLoginSupported: false,
      getModels: () => runtime.getModels(),
    }),
    runSingleQuery(prompt, options) {
      return runtime.runSingleQuery(prompt, options);
    },
  };
}
