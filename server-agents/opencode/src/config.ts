import type { AgentEnvironmentReader } from '@garcon/server-agent-interface';
import { readEnvironment } from '@garcon/server-agent-common/environment/read-environment';

export interface OpenCodeConfig {
  readonly isTestEnvironment: () => boolean;
}

export function createOpenCodeConfig(environment: AgentEnvironmentReader): OpenCodeConfig {
  return Object.freeze({
    isTestEnvironment: () => readEnvironment(environment, 'NODE_ENV') === 'test',
  });
}
