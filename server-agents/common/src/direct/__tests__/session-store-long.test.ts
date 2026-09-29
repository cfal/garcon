import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile } from 'node:fs/promises';
import { createTestDirectSessionStore, removeTestDirectSessionStores } from './session-store-fixture.ts';

const SESSION_ID = '00000000-0000-4000-8000-00000000abcd';
// Long enough that parsing it in one pass would hold the event loop well past the limit.
const RUNS = 20_000;
const MAX_GAP_MS = 50;

afterEach(removeTestDirectSessionStores);

function runId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

describe('long Direct sessions', () => {
  test('load every record without holding the event loop for the whole file', async () => {
    const store = createTestDirectSessionStore();
    const created = await store.create({ sessionId: SESSION_ID, runId: runId(0), content: 'first', attachments: [] });
    let appended = `${JSON.stringify({ type: 'assistant', at: created.header.createdAt, runId: runId(0), content: 'answer 0', checkpoint: null })}\n`;
    for (let index = 1; index < RUNS; index += 1) {
      const at = created.header.createdAt;
      appended += `${JSON.stringify({ type: 'user', at, runId: runId(index), content: `request ${index}`, attachments: [] })}\n`;
      appended += `${JSON.stringify({ type: 'assistant', at, runId: runId(index), content: `answer ${index}`, checkpoint: null })}\n`;
    }
    await appendFile(created.path, appended);

    let last = performance.now();
    let longestGap = 0;
    const probe = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    }, 1);
    const loaded = await store.load(SESSION_ID);
    // A final synchronous stretch ends before the probe runs again, so it gets one more turn.
    await new Promise((resolve) => setTimeout(resolve, 5));
    clearInterval(probe);

    expect(loaded.records).toHaveLength(RUNS * 2);
    expect(loaded.records.at(-1)).toMatchObject({ type: 'assistant', runId: runId(RUNS - 1), content: `answer ${RUNS - 1}` });
    expect(longestGap).toBeLessThan(MAX_GAP_MS);
  });
});
