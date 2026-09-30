import { describe, expect, it } from 'bun:test';
import { PaginatedCodexHistorySource } from '../paginated-history-source.ts';

// Long enough that converting it in one pass would hold the event loop well past the limit.
const TURNS = 20_000;
const MAX_GAP_MS = 50;

const profile = {
  mode: 'paginated',
  nativePath: '/tmp/sanitized-rollout.jsonl',
  threadId: 'thread-1',
  createdAt: '2026-07-20T00:00:00.000Z',
  historyBase: null,
};

const noEvidence = async () => ({ messages: [], orderedItemIdsByTurn: new Map() });

function pages(data) {
  const byCursor = new Map();
  for (let start = 0; start < data.length; start += 100) {
    byCursor.set(start === 0 ? 'first' : `page-${start}`, {
      data: data.slice(start, start + 100),
      nextCursor: start + 100 < data.length ? `page-${start + 100}` : null,
      backwardsCursor: null,
    });
  }
  return byCursor;
}

// Answers each page on a later event-loop turn, as the app-server's stdio does.
function clientForPages(turnPages, itemPages) {
  const answer = (page) => new Promise((resolve) => setImmediate(() => resolve(page)));
  return {
    listThreadTurns: async ({ cursor }) => answer(turnPages.get(cursor ?? 'first')),
    listThreadItems: async ({ cursor }) => answer(itemPages.get(cursor ?? 'first')),
    shutdown() {},
  };
}

describe('long Codex paginated history', () => {
  it('converts every item in provider order without holding the event loop for the whole history', async () => {
    const turns = [];
    const items = [];
    for (let index = 0; index < TURNS; index += 1) {
      const turnId = `turn-${index}`;
      turns.push({
        id: turnId, items: [], itemsView: 'notLoaded', status: 'completed', error: null,
        startedAt: 1_753_056_000 + index, completedAt: 1_753_056_000 + index, durationMs: 0,
      });
      items.push({ turnId, item: { type: 'userMessage', id: `user-${index}`, content: [{ type: 'text', text: `Synthetic request ${index}` }] } });
      items.push({ turnId, item: { type: 'agentMessage', id: `agent-${index}`, text: `Synthetic answer ${index}`, phase: null, memoryCitation: null } });
    }
    const source = new PaginatedCodexHistorySource(profile, () => clientForPages(pages(turns), pages(items)), noEvidence);

    let last = performance.now();
    let longestGap = 0;
    const probe = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    }, 1);
    const messages = await source.load(new AbortController().signal);
    // A final synchronous stretch ends before the probe runs again, so it gets one more turn.
    await new Promise((resolve) => setTimeout(resolve, 5));
    clearInterval(probe);

    expect(messages.map((message) => [message.type, message.content])).toEqual(
      Array.from({ length: TURNS }, (_, index) => [
        ['user-message', `Synthetic request ${index}`],
        ['assistant-message', `Synthetic answer ${index}`],
      ]).flat(),
    );
    expect(longestGap).toBeLessThan(MAX_GAP_MS);
  });
});
