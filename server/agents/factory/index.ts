import { runSingleQuery as runSingleQueryFactory, type FactoryCliRuntime } from './factory-cli.js';
import { getFactoryAuthStatus } from './factory-auth.js';
import { createAgentCapabilities } from '../capabilities.js';
import { createFactoryTranscriptSource } from './factory-transcript-source.js';
import type { Agent } from '../types.js';

export function createFactoryAgent(factory: FactoryCliRuntime): Agent {
  return {
    id: 'factory',
    label: 'Factory',
    runtime: factory,
    transcript: createFactoryTranscriptSource(),
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
