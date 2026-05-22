import {
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_LABEL,
} from '../../../common/providers.js';
import type { ApiProviderStore } from '../../providers/api-provider-store.js';
import { createHarnessCapabilities } from '../capabilities.js';
import { EMPTY_TRANSCRIPT_SOURCE } from '../shared/empty-transcript-source.js';
import type { Harness } from '../types.js';
import { createDirectOpenAiChatRuntime } from './router.js';

const NO_AUTH_STATUS = {
  authenticated: false,
  canReauth: false,
  label: '',
  source: 'none',
};

export function createDirectOpenAiChatHarness(apiProviderStore: ApiProviderStore): Harness {
  const runtime = createDirectOpenAiChatRuntime(apiProviderStore);
  return {
    id: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_ID,
    label: DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_HARNESS_LABEL,
    runtime,
    transcript: EMPTY_TRANSCRIPT_SOURCE,
    auth: { async getAuthStatus() { return NO_AUTH_STATUS; } },
    capabilities: createHarnessCapabilities({
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
