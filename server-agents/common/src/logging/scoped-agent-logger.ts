import type { JsonObject } from '@garcon/common/json';
import type { AgentLogger } from '@garcon/server-agent-interface';

export function createScopedAgentLogger(
  logger: AgentLogger,
  scope: string,
): AgentLogger {
  const fields = (value?: JsonObject): JsonObject => ({
    scope,
    ...(value ?? {}),
  });
  return {
    debug: (message, value) => logger.debug(message, fields(value)),
    info: (message, value) => logger.info(message, fields(value)),
    warn: (message, value) => logger.warn(message, fields(value)),
    error: (message, value) => logger.error(message, fields(value)),
  };
}
