import { getNativeMessageRevisionSource } from '../../../../server-agents/common/src/shared/native-message-source.ts';
import {
  convertOpenCodeStoredMessages,
  latestOpenCodeStoredActivityAt,
  type OpenCodeMessage,
} from '../../../../server-agents/opencode/src/agents/opencode/history-loader.ts';

export async function convertHistory(messages: OpenCodeMessage[]) {
  return {
    rows: (await convertOpenCodeStoredMessages(messages)).map((row) => ({
      row: JSON.parse(JSON.stringify(row)),
      source: getNativeMessageRevisionSource(row),
    })),
    lastActivity: await latestOpenCodeStoredActivityAt(messages),
  };
}
