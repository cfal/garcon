import {
  DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
  DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_LABEL,
} from '../../../common/providers.js';
import type { ApiProviderStore } from '../../providers/api-provider-store.js';
import { createHarnessCapabilities } from '../capabilities.js';
import { EMPTY_TRANSCRIPT_SOURCE } from '../shared/empty-transcript-source.js';
import type { Harness } from '../types.js';
import { createDirectAnthropicRuntime } from './router.js';

const NO_AUTH_STATUS = {
  authenticated: false,
  canReauth: false,
  label: '',
  source: 'none',
};

export function createDirectAnthropicHarness(apiProviderStore: ApiProviderStore): Harness {
  const runtime = createDirectAnthropicRuntime(apiProviderStore);
  return {
    id: DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_ID,
    label: DIRECT_ANTHROPIC_COMPATIBLE_HARNESS_LABEL,
    runtime,
    transcript: EMPTY_TRANSCRIPT_SOURCE,
    auth: { async getAuthStatus() { return NO_AUTH_STATUS; } },
    capabilities: createHarnessCapabilities({
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
