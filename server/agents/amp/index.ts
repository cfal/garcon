import { runSingleQuery as runSingleQueryAmp, type AmpCliRuntime } from './amp-cli.js';
import { getAmpAuthStatus } from './amp-auth.js';
import { createAgentCapabilities } from '../capabilities.js';
import { createArtificialTranscriptSource } from '../shared/artificial-transcript-source.js';
import type { Agent } from '../types.js';

export function createAmpAgent(amp: AmpCliRuntime): Agent {
  return {
    id: 'amp',
    label: 'Amp',
    runtime: amp,
    transcript: createArtificialTranscriptSource('amp'),
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
