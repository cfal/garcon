// Recorded inputs for `turn-failure.ts`: the functions take a turn context
// and read the wall clock, so the oracle builds the turn from JSON state and
// fixes the clock.

import { getNativeMessageSource } from "../../../../server-agents/common/src/shared/native-message-source.ts";
import {
  latestOpenCodePromptTerminal,
  openCodeProviderFailureRow,
} from "../../../../server-agents/opencode/src/agents/opencode/turn-failure.ts";

import { buildTurn, snapshotTurn, withFixedWallClock } from "./turn-state.ts";

export function latestTerminal(turn: Record<string, unknown>) {
  const terminal = latestOpenCodePromptTerminal(buildTurn(turn));
  return terminal ?? null;
}

export function providerFailureRow(message: string, entryId: string | null, turn: Record<string, unknown>) {
  const context = buildTurn(turn);
  const row = withFixedWallClock(() => openCodeProviderFailureRow(message, entryId ?? undefined, context));
  return {
    row: JSON.parse(JSON.stringify(row)),
    source: getNativeMessageSource(row),
    turn: snapshotTurn(context),
  };
}
