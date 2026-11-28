// Recorded inputs for `compaction-routing.ts`: its functions take a turn, a
// session, and the operation routes, so the oracle builds them from JSON.

import {
  adoptOpenCodeCompactionPartRoute,
  compactionBoundaryRow,
  compactionEventTrigger,
} from "../../../../server-agents/opencode/src/agents/opencode/compaction-routing.ts";
import { OpenCodeOperationRoutes } from "../../../../server-agents/opencode/src/agents/opencode/operation-routes.ts";

import { buildSession, recordingLogger, snapshotTurn } from "./turn-state.ts";

export function boundaryRow(event: Record<string, unknown>, trigger: string) {
  const boundary = compactionBoundaryRow(event as never, trigger as never);
  return boundary === null ? null : { row: JSON.parse(JSON.stringify(boundary.row)), summaryMessageId: boundary.summaryMessageId };
}

export function eventTrigger(event: Record<string, unknown>, turn: Record<string, unknown>) {
  return compactionEventTrigger(event as never, buildSession({ turn }).turn);
}

// The session's turn has one registered route, as a running turn does.
export function adoptPartRoute(session: Record<string, unknown> | null, event: Record<string, unknown>, sessionId: string) {
  const { lines, logger } = recordingLogger();
  const routes = new OpenCodeOperationRoutes(logger as never);
  const context = session === null ? null : buildSession(session);
  if (context) {
    routes.register(sessionId, context.chatId, context.turn, true, context.permissionMode, context.directory);
  }
  const route = adoptOpenCodeCompactionPartRoute({
    event: event as never,
    logger: logger as never,
    operationRoutes: routes,
    session: context,
    sessionId,
  });
  return {
    adopted: route !== null,
    resolvable: route !== null && routes.resolve(sessionId, event as never) === route,
    idle: routes.idle,
    turn: context ? snapshotTurn(context.turn) : null,
    log: lines,
  };
}
