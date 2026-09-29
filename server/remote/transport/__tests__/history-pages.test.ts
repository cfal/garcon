import { expect, test } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import type { AgentImportedTranscriptRow } from '@garcon/server-agent-interface';
import { PAGE_BYTES, historyPages } from '../history-pages.js';

function pageBytes(rows: readonly AgentImportedTranscriptRow[]): number {
  return rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
}

test('fills each page across small source batches', async () => {
  async function* source() {
    for (let batch = 0; batch < 8; batch += 1) {
      yield Array.from({ length: 256 }, (_, index) => ({
        message: new AssistantMessage('2026-01-01T00:00:00Z', `${batch * 256 + index}:${'x'.repeat(1_000)}`),
      }));
    }
  }

  const pages: AgentImportedTranscriptRow[][] = [];
  for await (const page of historyPages(source())) pages.push([...page]);

  expect(pages.flat().map((row) => Number((row.message as AssistantMessage).content.split(':')[0])))
    .toEqual(Array.from({ length: 8 * 256 }, (_, index) => index));
  for (const [index, page] of pages.entries()) {
    expect(pageBytes(page)).toBeLessThanOrEqual(PAGE_BYTES);
    if (index < pages.length - 1) expect(pageBytes([...page, pages[index + 1]![0]!])).toBeGreaterThan(PAGE_BYTES);
  }
});
