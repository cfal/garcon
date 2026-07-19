import type { AgentEnvironmentReader } from '@garcon/server-agent-interface';

export function readEnvironment(
  environment: AgentEnvironmentReader,
  name: string,
): string | null {
  return environment.get(name)?.trim() || null;
}
