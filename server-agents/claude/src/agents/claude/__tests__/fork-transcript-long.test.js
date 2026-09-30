import { describe, expect, it } from 'bun:test';
import { convertClaudeEntries, sortClaudeEntries } from '../history-loader.js';
import { claudeForkSemanticDigest, createClaudeForkTranscriptTransformer } from '../fork-transcript.js';

// Long enough that transforming it in one pass would hold the event loop well past the limit.
const ENTRY_PAIRS = 20_000;
const MAX_GAP_MS = 50;

function syntheticTranscript() {
  const entries = [];
  let parentUuid = null;
  for (let index = 0; index < ENTRY_PAIRS; index += 1) {
    const timestamp = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    const user = {
      sessionId: 'source-session',
      type: 'user',
      uuid: `00000000-0000-4000-8000-${String(index * 2).padStart(12, '0')}`,
      parentUuid,
      timestamp,
      message: { role: 'user', content: `Synthetic request ${index} ${'generic words '.repeat(40)}` },
    };
    const assistant = {
      sessionId: 'source-session',
      type: 'assistant',
      uuid: `00000000-0000-4000-8000-${String(index * 2 + 1).padStart(12, '0')}`,
      parentUuid: user.uuid,
      timestamp,
      message: { role: 'assistant', content: [{ type: 'text', text: `Synthetic answer ${index}` }] },
    };
    entries.push(user, assistant);
    parentUuid = assistant.uuid;
  }
  return entries;
}

// Runs the work while probing the event loop and returns its result and the longest gap.
async function withLongestGap(work) {
  let last = performance.now();
  let longestGap = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    longestGap = Math.max(longestGap, now - last);
    last = now;
  }, 1);
  const result = await work();
  // A final synchronous stretch ends before the probe runs again, so it gets one more turn.
  await new Promise((resolve) => setTimeout(resolve, 5));
  clearInterval(probe);
  return { result, longestGap };
}

describe('long Claude session fork', () => {
  it('transforms and digests the transcript without holding the event loop for the whole of it', async () => {
    const entries = syntheticTranscript();
    let uuid = 0;
    const transform = createClaudeForkTranscriptTransformer({
      randomUUID: () => `10000000-0000-4000-8000-${String(uuid++).padStart(12, '0')}`,
      now: () => '2026-02-01T00:00:00.000Z',
    });

    const transformed = await withLongestGap(() => transform({
      selectedEntries: entries,
      sourceEntries: entries,
      sourceAgentSessionId: 'source-session',
      targetAgentSessionId: 'target-session',
    }));
    const forked = convertClaudeEntries(sortClaudeEntries([...transformed.result.entries]));
    const digested = await withLongestGap(() => claudeForkSemanticDigest(forked));

    expect(transformed.result.entries).toHaveLength(ENTRY_PAIRS * 2);
    expect(transformed.result.entries.every((entry) => entry.sessionId === 'target-session')).toBe(true);
    expect(forked).toHaveLength(ENTRY_PAIRS * 2);
    expect(transformed.result.expectedSemanticDigest).toBe(digested.result);
    expect(transformed.longestGap).toBeLessThan(MAX_GAP_MS);
    expect(digested.longestGap).toBeLessThan(MAX_GAP_MS);
  });
});
