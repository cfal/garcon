import os from 'node:os';
import type { AgentEnvironmentReader } from '@garcon/server-agent-interface';
import { readEnvironment } from '@garcon/server-agent-common/environment/read-environment';

export interface PiConfig {
  readonly binary: () => string;
  readonly agentDirectoryOverride: () => string | null;
  readonly sessionDirectoryOverride: () => string | null;
  readonly homeDirectory: () => string;
  readonly isTestEnvironment: () => boolean;
}

export function createPiConfig(environment: AgentEnvironmentReader): PiConfig {
  return Object.freeze({
    binary: () => readEnvironment(environment, 'GARCON_PI_BINARY')
      ?? readEnvironment(environment, 'PI_BINARY')
      ?? 'pi',
    agentDirectoryOverride: () => readEnvironment(environment, 'PI_CODING_AGENT_DIR'),
    sessionDirectoryOverride: () => (
      readEnvironment(environment, 'PI_CODING_AGENT_SESSION_DIR') ?? null
    ),
    homeDirectory: () => process.platform === 'win32' ? os.homedir() : readEnvironment(environment, 'HOME') ?? os.homedir(),
    isTestEnvironment: () => readEnvironment(environment, 'NODE_ENV') === 'test',
  });
}
