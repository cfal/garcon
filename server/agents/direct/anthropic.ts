import {
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL,
} from '../../../common/agents.js';
import type { ApiProviderReader } from '../../api-providers/read-model.js';
import { createAgentCapabilities } from '../capabilities.js';
import type { Agent } from '../types.js';
import {
  createDirectAnthropicRuntime,
  directAnthropicSessionFilePath,
} from './router.js';
import { createDirectCompatibleTranscriptSource } from './transcript-source.js';

const NO_AUTH_STATUS = {
  authenticated: false,
  canReauth: false,
  label: '',
  source: 'none',
};

export function createDirectAnthropicAgent(apiProviders: ApiProviderReader): Agent {
  const runtime = createDirectAnthropicRuntime(apiProviders);
  return {
    id: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
    label: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL,
    runtime,
    transcript: createDirectCompatibleTranscriptSource({
      agentId: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
      protocol: 'anthropic-messages',
      sessionLabel: DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL,
      apiProviders,
      getSessionFilePath: directAnthropicSessionFilePath,
    }),
    auth: { async getAuthStatus() { return NO_AUTH_STATUS; } },
    capabilities: createAgentCapabilities({
      supportsFork: false,
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
