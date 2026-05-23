import {
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
} from '../../../common/providers.js';
import type { ApiProviderStore } from '../../api-providers/store.js';
import { createAgentCapabilities } from '../capabilities.js';
import { EMPTY_TRANSCRIPT_SOURCE } from '../shared/empty-transcript-source.js';
import type { Agent } from '../types.js';
import { createDirectOpenAiResponsesRuntime } from './router.js';

const NO_AUTH_STATUS = {
  authenticated: false,
  canReauth: false,
  label: '',
  source: 'none',
};

export function createDirectOpenAiResponsesAgent(apiProviderStore: ApiProviderStore): Agent {
  const runtime = createDirectOpenAiResponsesRuntime(apiProviderStore);
  return {
    id: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
    label: DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL,
    runtime,
    transcript: EMPTY_TRANSCRIPT_SOURCE,
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
