import { runSingleQuery as runSingleQueryPi, type PiProvider } from '../../providers/pi-cli.js';
import { getPiAuthStatus } from '../../providers/pi-auth.js';
import { createHarnessCapabilities } from '../capabilities.js';
import { EMPTY_TRANSCRIPT_SOURCE } from '../shared/empty-transcript-source.js';
import type { Harness } from '../types.js';

export function createPiHarness(pi: PiProvider): Harness {
  return {
    id: 'pi',
    label: 'Pi',
    runtime: pi,
    transcript: EMPTY_TRANSCRIPT_SOURCE,
    auth: { getAuthStatus: () => getPiAuthStatus() },
    capabilities: createHarnessCapabilities({
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
