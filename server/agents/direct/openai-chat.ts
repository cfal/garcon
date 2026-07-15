import {
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL,
} from '../../../common/agents.js';
import type { ApiProviderReader } from '../../api-providers/read-model.js';
import { createAgentCapabilities } from '../capabilities.js';
import type { Agent } from '../types.js';
import { createDirectOpenAiChatRuntime } from './router.js';
import { createDirectSessionPaths } from './session-paths.js';
import { createDirectCompatibleTranscriptSource } from './transcript-source.js';

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
