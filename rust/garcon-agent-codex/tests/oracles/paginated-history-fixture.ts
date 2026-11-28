import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const trace = process.env.SYNTHETIC_CODEX_TRACE!;
const mode = process.env.SYNTHETIC_CODEX_MODE;
const answer = (id: string, text: string) => ({
  turnId: 'turn', item: { type: 'agentMessage', id, text, phase: null, memoryCitation: null },
});
const page = (data: unknown[], nextCursor: string | null) => ({ data, nextCursor, backwardsCursor: null });
for await (const line of createInterface({ input: process.stdin })) {
  appendFileSync(trace, line + '\n');
  const { id, method, params } = JSON.parse(line);
  let result: unknown;
  switch (method) {
    case 'initialize':
      result = { userAgent: 'codex/0.171.0', codexHome: '/synthetic', platformFamily: 'unix', platformOs: 'linux' };
      break;
    case 'thread/items/list':
      result = mode === 'repeated-cursor'
        ? page([], 'repeat')
        : params.cursor === null
          ? page([answer('first', 'First reply.')], 'second-page')
          : page(mode === 'ambiguous'
            ? [answer('unanchored', 'Unanchored reply.'), answer('last', 'Last reply.')]
            : [answer('last', 'Last reply.')], null);
      break;
    case 'thread/turns/list':
      result = page([{
        id: 'turn', items: [], itemsView: 'notLoaded', status: 'completed', error: null,
        startedAt: 1_753_056_000, completedAt: null, durationMs: null,
      }], null);
      break;
    default:
      if (id !== undefined) throw new Error(`Unexpected request ${method}`);
      continue;
  }
  process.stdout.write(JSON.stringify({ id, result }) + '\n');
}
