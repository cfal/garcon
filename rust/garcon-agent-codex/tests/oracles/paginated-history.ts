import { CodexAppServerClient } from '../../../../server-agents/codex/src/agents/codex/app-server/client.ts';
import { PaginatedCodexHistorySource } from '../../../../server-agents/codex/src/agents/codex/app-server/paginated-history-source.ts';
import { getNativeMessageRevisionSource } from '../../../../server-agents/interface/src/native-message-source.ts';

const [command, trace, mode, nativePath] = process.argv.slice(2) as [string, string, string, string];
const client = new CodexAppServerClient({
  resolveCli: async () => ({ command, source: 'path' }),
  env: { SYNTHETIC_CODEX_TRACE: trace, SYNTHETIC_CODEX_MODE: mode },
});
const source = new PaginatedCodexHistorySource({
  mode: 'paginated', threadId: 'thread', nativePath,
  createdAt: '2026-01-01T00:00:00.000Z', historyBase: null,
}, () => client);
try {
  const messages = await source.load(new AbortController().signal);
  process.stdout.write(JSON.stringify({ messages: messages.map(message => ({
    message, source: getNativeMessageRevisionSource(message),
  })) }));
} catch (error) {
  const e = error as Error & { code?: string; retryable?: boolean; details?: unknown };
  process.stdout.write(JSON.stringify({ error: e.message, code: e.code, retryable: e.retryable, details: e.details }));
}
