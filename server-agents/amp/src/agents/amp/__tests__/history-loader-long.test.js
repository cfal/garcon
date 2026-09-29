import { describe, expect, it } from 'bun:test';
import { loadAmpChatMessages } from '../history-loader.js';

// Long enough that converting it in one pass would hold the event loop well past the limit.
const TURNS = 30_000;
const MAX_GAP_MS = 50;

function syntheticThreadExport() {
  const messages = [];
  for (let turn = 0; turn < TURNS; turn += 1) {
    messages.push({
      role: 'user',
      messageId: turn * 2,
      content: [{ type: 'text', text: `Synthetic request ${turn} ${'generic words '.repeat(10)}` }],
    });
    messages.push({
      role: 'assistant',
      messageId: turn * 2 + 1,
      content: [
        { type: 'text', text: `Synthetic answer ${turn}` },
        { type: 'tool_use', id: `tool-${turn}`, name: 'Read', input: { path: `/tmp/synthetic-${turn}.ts` } },
      ],
    });
  }
  return { id: 'T-synthetic', created: 1773796295774, messages };
}

describe('long Amp thread exports', () => {
  it('convert every message without holding the event loop for the whole thread', async () => {
    const threadExport = syntheticThreadExport();
    let last = performance.now();
    let longestGap = 0;
    const probe = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    }, 1);
    const messages = await loadAmpChatMessages(threadExport);
    // A final synchronous stretch ends before the probe runs again, so it gets one more turn.
    await new Promise((resolve) => setTimeout(resolve, 5));
    clearInterval(probe);

    expect(messages).toHaveLength(TURNS * 3);
    expect(messages[0]).toMatchObject({ type: 'user-message' });
    expect(messages.at(-2)).toMatchObject({ type: 'assistant-message', content: `Synthetic answer ${TURNS - 1}` });
    expect(longestGap).toBeLessThan(MAX_GAP_MS);
  });
});
