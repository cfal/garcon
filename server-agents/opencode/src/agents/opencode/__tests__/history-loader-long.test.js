import { describe, expect, it } from 'bun:test';
import { loadOpenCodeChatMessages } from '../history-loader.js';

// Long enough that converting it in one pass would hold the event loop well past the limit.
const TURNS = 20_000;
const MAX_GAP_MS = 50;

function syntheticStoredMessages() {
  const messages = [];
  for (let turn = 0; turn < TURNS; turn += 1) {
    messages.push({
      info: { id: `user-${turn}`, role: 'user', time: { created: '2026-07-04T00:00:00.000Z' } },
      parts: [{ id: `user-part-${turn}`, type: 'text', text: `Synthetic request ${turn} ${'generic words '.repeat(10)}` }],
    });
    messages.push({
      info: { id: `assistant-${turn}`, role: 'assistant', time: { created: '2026-07-04T00:00:01.000Z' } },
      parts: [
        { id: `text-part-${turn}`, type: 'text', text: `Synthetic answer ${turn}` },
        {
          id: `tool-part-${turn}`,
          type: 'tool',
          tool: 'bash',
          callID: `tool-${turn}`,
          state: { status: 'completed', input: { command: 'pwd' }, output: 'ok' },
        },
      ],
    });
  }
  return messages;
}

describe('long OpenCode sessions', () => {
  it('convert every stored message without holding the event loop for the whole session', async () => {
    const data = syntheticStoredMessages();
    const getClient = () => Promise.resolve({ session: { messages: () => Promise.resolve({ data }) } });
    let last = performance.now();
    let longestGap = 0;
    const probe = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    }, 1);
    const messages = await loadOpenCodeChatMessages('synthetic-session', getClient);
    // A final synchronous stretch ends before the probe runs again, so it gets one more turn.
    await new Promise((resolve) => setTimeout(resolve, 5));
    clearInterval(probe);

    expect(messages).toHaveLength(TURNS * 4);
    expect(messages[0]).toMatchObject({ type: 'user-message' });
    expect(messages.filter((message) => message.type === 'assistant-message').at(-1))
      .toMatchObject({ content: `Synthetic answer ${TURNS - 1}` });
    expect(longestGap).toBeLessThan(MAX_GAP_MS);
  });
});
