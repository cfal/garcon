import { runSingleQuery as runSingleQueryAmp, type AmpProvider } from '../../providers/amp-cli.js';
import { getAmpAuthStatus } from '../../providers/amp-auth.js';
import { createAgentCapabilities } from '../capabilities.js';
import { EMPTY_TRANSCRIPT_SOURCE } from '../shared/empty-transcript-source.js';
import type { Agent } from '../types.js';

export function createAmpAgent(amp: AmpProvider): Agent {
  return {
    id: 'amp',
    label: 'Amp',
    runtime: amp,
    transcript: EMPTY_TRANSCRIPT_SOURCE,
    auth: { getAuthStatus: () => getAmpAuthStatus() },
    capabilities: createAgentCapabilities({
      supportsFork: false,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
    }),
    runSingleQuery: runSingleQueryAmp,
  };
}
