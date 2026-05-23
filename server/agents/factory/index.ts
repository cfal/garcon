import { runSingleQuery as runSingleQueryFactory, type FactoryProvider } from './factory-cli.js';
import { getFactoryAuthStatus } from './factory-auth.js';
import { createAgentCapabilities } from '../capabilities.js';
import { createArtificialTranscriptSource } from '../shared/artificial-transcript-source.js';
import type { Agent } from '../types.js';

export function createFactoryAgent(factory: FactoryProvider): Agent {
  return {
    id: 'factory',
    label: 'Factory',
    runtime: factory,
    transcript: createArtificialTranscriptSource('factory'),
    auth: { getAuthStatus: () => getFactoryAuthStatus() },
    capabilities: createAgentCapabilities({
      supportsFork: false,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
      getModels: () => factory.getModels(),
    }),
    runSingleQuery: runSingleQueryFactory,
  };
}
