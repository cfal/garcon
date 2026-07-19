import type { AgentEnvironmentReader } from '@garcon/server-agent-interface';
import { readEnvironment } from '@garcon/server-agent-common/environment/read-environment';

export interface AmpConfig {
  readonly binary: () => string;
}

export function createAmpConfig(environment: AgentEnvironmentReader): AmpConfig {
  return Object.freeze({
    binary: () => readEnvironment(environment, 'AMP_BINARY') ?? 'amp',
  });
}
