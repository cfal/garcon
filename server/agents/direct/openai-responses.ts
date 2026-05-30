import {
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
} from '../../../common/agents.js';
import type { ApiProviderReader } from '../../api-providers/read-model.js';
import { createAgentCapabilities } from '../capabilities.js';
import { createArtificialTranscriptSource } from '../shared/artificial-transcript-source.js';
import type { Agent } from '../types.js';
import { createDirectOpenAiResponsesRuntime } from './router.js';

const NO_AUTH_STATUS = {
  authenticated: false,
  canReauth: false,
  label: '',
  source: 'none',
};

export function createDirectOpenAiResponsesAgent(apiProviders: ApiProviderReader): Agent {
  const runtime = createDirectOpenAiResponsesRuntime(apiProviders);
  return {
    id: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
    label: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
    runtime,
    transcript: createArtificialTranscriptSource(DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID),
    auth: { async getAuthStatus() { return NO_AUTH_STATUS; } },
    capabilities: createAgentCapabilities({
      supportsFork: false,
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
