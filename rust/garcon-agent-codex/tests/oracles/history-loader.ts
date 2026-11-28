import { join } from 'node:path';
import { loadCodexChatMessages } from '../../../../server-agents/codex/src/agents/codex/history-loader.ts';
import { getNativeMessageRevisionSource } from '../../../../server-agents/interface/src/native-message-source.ts';

const root = process.argv[2]!;
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const rows = [];
for (const [name, strict] of [['valid', true], ['malformed', true], ['malformed', false], ['wrong-part', true]] as const) {
  try {
    const messages = await loadCodexChatMessages(join(root, name), logger, { throwOnError: strict });
    rows.push({ messages: messages.map(message => ({ message, source: getNativeMessageRevisionSource(message) })) });
  } catch (error) {
    rows.push({ error: error instanceof Error ? error.message : String(error) });
  }
}
process.stdout.write(JSON.stringify(rows));
