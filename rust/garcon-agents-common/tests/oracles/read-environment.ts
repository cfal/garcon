import type { AgentEnvironmentReader } from "@garcon/server-agent-interface";
import { readEnvironment as originalReadEnvironment } from "../../../../server-agents/common/src/environment/read-environment.ts";

// Reads through a reader over a record, as an injected environment reader is.
export function readEnvironment(values: unknown, name: string): string | null {
  const record = values !== null && typeof values === "object" && !Array.isArray(values)
    ? (values as Record<string, unknown>)
    : {};
  const reader: AgentEnvironmentReader = {
    get: (key: string) => (Object.hasOwn(record, key) ? record[key] as string | undefined : undefined),
  };
  return originalReadEnvironment(reader, name);
}
