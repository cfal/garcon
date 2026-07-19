import type { AgentEnvironmentReader } from '@garcon/server-agent-interface';
import { readEnvironment } from '@garcon/server-agent-common/environment/read-environment';

export interface ClaudeConfig {
  readonly binary: () => string;
  readonly anthropicApiKey: () => string | null;
  readonly anthropicBaseUrl: () => string | null;
  readonly configHomeDir: () => string | null;
}

export function createClaudeConfig(environment: AgentEnvironmentReader): ClaudeConfig {
  return Object.freeze({
    binary: () => readEnvironment(environment, 'CLAUDE_BINARY') ?? 'claude',
    anthropicApiKey: () => readEnvironment(environment, 'ANTHROPIC_API_KEY'),
    anthropicBaseUrl: () => readEnvironment(environment, 'ANTHROPIC_BASE_URL'),
    configHomeDir: () => readEnvironment(environment, 'CLAUDE_CONFIG_DIR'),
  });
}
