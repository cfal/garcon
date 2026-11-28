// Recorded inputs for the turn functions of `turn-events.ts` that take the
// original's mutable turn and session objects: the recorder calls these with
// JSON state, and each returns the state after the call.

import {
  acceptUniqueOpenCodeTurnEvent,
  activateOpenCodeSessionTurn,
  openCodeEventBelongsToTurn,
  observeOpenCodeSteeringPart,
  openCodeTurnRequiresProviderQuiescence,
  relocateOpenCodeSession,
  shouldWarnForUnroutedOpenCodeEvent,
} from "../../../../server-agents/opencode/src/agents/opencode/turn-events.ts";

import {
  FIXED_NOW,
  buildSession,
  buildTurn,
  recordingLogger,
  snapshotSession,
  snapshotTurn,
  withFixedWallClock,
} from "./turn-state.ts";

export { shouldWarnForUnroutedOpenCodeEvent };

export function turnRequiresQuiescence(turn: Record<string, unknown>) {
  return openCodeTurnRequiresProviderQuiescence(buildTurn(turn));
}

export function eventBelongsToTurn(turn: Record<string, unknown>, event: Record<string, unknown>) {
  const published: unknown[] = [];
  const context = buildTurn(turn, published);
  const belongs = openCodeEventBelongsToTurn(context, event as never);
  return { belongs, published, turn: snapshotTurn(context) };
}

export function observeSteeringPart(session: Record<string, unknown>, event: Record<string, unknown>) {
  const context = buildSession(session);
  const partId = observeOpenCodeSteeringPart(context, event as never);
  return { partId: partId ?? null, turn: snapshotTurn(context.turn) };
}

export function acceptTurnEvent(turn: Record<string, unknown>, event: Record<string, unknown>) {
  const context = buildTurn(turn);
  const { lines, logger } = recordingLogger();
  const accepted = acceptUniqueOpenCodeTurnEvent(context, event as never, logger as never);
  return { accepted, turn: snapshotTurn(context), log: lines };
}

export function activateSessionTurn(session: Record<string, unknown>, input: Record<string, unknown>) {
  const context = buildSession(session);
  withFixedWallClock(() => activateOpenCodeSessionTurn(context, {
    chatId: input.chatId as string,
    model: input.model as string | undefined,
    thinkingVariant: input.thinkingVariant as string | undefined,
    permissionMode: input.permissionMode as never,
    directory: input.directory as string | undefined,
    turn: buildTurn((input.turn as Record<string, unknown> | undefined) ?? {}),
  }));
  return snapshotSession(context);
}

export function relocateSession(session: Record<string, unknown>, directory: string) {
  const context = buildSession(session);
  withFixedWallClock(() => relocateOpenCodeSession(context, directory));
  return { now: FIXED_NOW, session: snapshotSession(context) };
}
