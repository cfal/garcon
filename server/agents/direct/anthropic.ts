import {
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL,
} from '../../../common/agents.js';
import type { ApiProviderReader } from '../../api-providers/read-model.js';
import { createAgentCapabilities } from '../capabilities.js';
import { createArtificialTranscriptSource } from '../shared/artificial-transcript-source.js';
import type { Agent } from '../types.js';
import { createDirectAnthropicRuntime } from './router.js';

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
    transcript: createArtificialTranscriptSource(DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID),
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
