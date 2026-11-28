import {
  convertClaudeEntries,
  loadClaudeChatMessages,
  parseClaudeJsonlEntryWithSource,
  sortClaudeEntries,
} from '../../../../server-agents/claude/src/agents/claude/history-loader.ts';
import type { ChatMessage } from '../../../../common/chat-types.ts';
import { getNativeMessageRevisionSource } from '../../../../server-agents/interface/src/native-message-source.ts';

export function parseHistoryEntry(line: string, lineNumber: number) {
  const entry = parseClaudeJsonlEntryWithSource(line, lineNumber);
  return entry && {
    entry: JSON.parse(JSON.stringify(entry)) as Record<string, unknown>,
    source: getNativeMessageRevisionSource(entry) ?? null,
  };
}

export function convertHistoryLines(lines: string[]) {
  const entries = lines.flatMap((line, index) => {
    const entry = parseClaudeJsonlEntryWithSource(line, index + 1);
    return entry ? [entry] : [];
  });
  return convertClaudeEntries(sortClaudeEntries(entries)).map((message) => ({
    message: JSON.parse(JSON.stringify(message)) as ChatMessage,
    source: getNativeMessageRevisionSource(message) ?? null,
  }));
}

if (import.meta.main) {
  const [path, mode] = process.argv.slice(2);
  try {
    const messages = await loadClaudeChatMessages(path, undefined, { throwOnError: mode === 'strict' });
    process.stdout.write(JSON.stringify(messages.map((message) => ({
      message,
      source: getNativeMessageRevisionSource(message),
    }))));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}
