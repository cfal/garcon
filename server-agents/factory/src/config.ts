import type { AgentEnvironmentReader } from '@garcon/server-agent-interface';
import { readEnvironment } from '@garcon/server-agent-common/environment/read-environment';

export interface FactoryConfig {
  readonly binary: () => string;
  readonly apiKey: () => string | null;
  readonly homeOverride: () => string | null;
}

export function createFactoryConfig(environment: AgentEnvironmentReader): FactoryConfig {
  return Object.freeze({
    binary: () => readEnvironment(environment, 'FACTORY_BINARY') ?? 'droid',
    apiKey: () => readEnvironment(environment, 'FACTORY_API_KEY'),
    homeOverride: () => readEnvironment(environment, 'FACTORY_HOME_OVERRIDE'),
  });
}
