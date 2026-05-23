import { runSingleQuery as runSingleQueryPi, type PiProvider } from './pi-cli.js';
import { getPiAuthStatus } from './pi-auth.js';
import { createAgentCapabilities } from '../capabilities.js';
import { EMPTY_TRANSCRIPT_SOURCE } from '../shared/empty-transcript-source.js';
import type { Agent } from '../types.js';

export function createPiAgent(pi: PiProvider): Agent {
  return {
    id: 'pi',
    label: 'Pi',
    runtime: pi,
    transcript: EMPTY_TRANSCRIPT_SOURCE,
    auth: { getAuthStatus: () => getPiAuthStatus() },
    capabilities: createAgentCapabilities({
      supportsFork: false,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
      getModels: () => pi.getModels(),
    }),
    runSingleQuery: runSingleQueryPi,
  };
}
