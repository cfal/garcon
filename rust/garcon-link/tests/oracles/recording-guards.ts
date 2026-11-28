import { CLI_OPERATIONS } from "../../../../server/remote/transport/cli-protocol.js";

export function isRpcLane(value: unknown): boolean {
  return value === "primary" || value === "bulk";
}

export function isCliHttpRequest(http: unknown): boolean {
  return typeof http === "object" && http !== null && "operation" in http
    && typeof http.operation === "string" && Object.hasOwn(CLI_OPERATIONS, http.operation);
}
