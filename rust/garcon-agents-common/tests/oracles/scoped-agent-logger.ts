import type { AgentLogger, JsonObject } from "@garcon/server-agent-interface";
import { createScopedAgentLogger } from "../../../../server-agents/common/src/logging/scoped-agent-logger.ts";

// The fields the scoped logger hands its logger for one `info` call.
function fieldsFor(scope: string, value: JsonObject | undefined): unknown {
  let fields: unknown = "not called";
  const logger: AgentLogger = {
    debug: () => {},
    info: (_message, scoped) => { fields = scoped; },
    warn: () => {},
    error: () => {},
  };
  createScopedAgentLogger(logger, scope).info("message", value);
  return fields;
}

export const scopedFields = (scope: string, value: unknown) => fieldsFor(scope, value as JsonObject | undefined);

export const scopedFieldsWithoutValue = (scope: string) => fieldsFor(scope, undefined);
