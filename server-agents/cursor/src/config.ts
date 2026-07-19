import type { AgentEnvironmentReader } from '@garcon/server-agent-interface';
import { readEnvironment } from '@garcon/server-agent-common/environment/read-environment';

export interface CursorConfig {
  readonly binary: () => string;
  readonly apiKey: () => string | null;
}

export function createCursorConfig(environment: AgentEnvironmentReader): CursorConfig {
  return Object.freeze({
    binary: () => readEnvironment(environment, 'GARCON_CURSOR_BINARY')
      ?? readEnvironment(environment, 'CURSOR_BINARY')
      ?? 'cursor-agent',
    apiKey: () => readEnvironment(environment, 'CURSOR_API_KEY') ?? null,
  });
}
