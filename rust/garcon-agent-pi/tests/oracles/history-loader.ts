import { loadPiChatMessages } from '../../../../server-agents/pi/src/agents/pi/history-loader.ts';
import { getNativeMessageRevisionSource } from '../../../../server-agents/common/src/shared/native-message-source.ts';

const outcomes = [];
for (const file of Bun.argv.slice(2)) {
  try {
    const messages = await loadPiChatMessages(file);
    outcomes.push({ rows: messages.map(message => ({
      message, source: getNativeMessageRevisionSource(message) ?? null,
    })) });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    outcomes.push({ error: error.message });
  }
}
process.stdout.write(JSON.stringify(outcomes));
