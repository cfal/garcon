import { getNativeMessageRevisionSource } from '../../../../server-agents/common/src/shared/native-message-source.ts';
import { convertOpenCodeEventToChatMessages } from '../../../../server-agents/opencode/src/agents/opencode/event-converter.ts';
import type { SSEEvent } from '../../../../server-agents/opencode/src/agents/opencode/sse-events.ts';
import { buildTurn, recordingLogger, snapshotTurn, withFixedWallClock } from './turn-state.ts';

export function convertEvents(events: SSEEvent[]) {
  const turn = buildTurn();
  const { lines, logger } = recordingLogger();
  const results = withFixedWallClock(() => events.map((event) =>
    convertOpenCodeEventToChatMessages(event, turn, logger)?.map((row) => ({
      row: JSON.parse(JSON.stringify(row)),
      source: getNativeMessageRevisionSource(row),
    })) ?? null,
  ));
  return { results, turn: snapshotTurn(turn), log: lines };
}
