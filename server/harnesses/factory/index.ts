import { runSingleQuery as runSingleQueryFactory, type FactoryProvider } from '../../providers/factory-cli.js';
import { getFactoryAuthStatus } from '../../providers/factory-auth.js';
import { createHarnessCapabilities } from '../capabilities.js';
import { EMPTY_TRANSCRIPT_SOURCE } from '../shared/empty-transcript-source.js';
import type { Harness } from '../types.js';

export function createFactoryHarness(factory: FactoryProvider): Harness {
  return {
    id: 'factory',
    label: 'Factory',
    runtime: factory,
    transcript: EMPTY_TRANSCRIPT_SOURCE,
    auth: { getAuthStatus: () => getFactoryAuthStatus() },
    capabilities: createHarnessCapabilities({
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
