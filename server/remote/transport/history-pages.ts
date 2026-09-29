import { AgentCallError, type AgentImportedTranscriptRow } from '@garcon/server-agent-interface';
import { SESSION_MESSAGE_BYTES } from './session-socket.js';

export const PAGE_BYTES = 1024 * 1024;

// Pages fill across source batches, which providers keep small so the worker's
// event loop gets a turn between them.
export async function* historyPages(source: AsyncIterable<readonly AgentImportedTranscriptRow[]>) {
  let page: AgentImportedTranscriptRow[] = [];
  let bytes = 0;
  for await (const rows of source) {
    for (const row of rows) {
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (size > SESSION_MESSAGE_BYTES - 1024) {
        throw new AgentCallError('rejected', 'History row exceeds the executor message size limit');
      }
      if (page.length && bytes + size > PAGE_BYTES) { yield page; page = []; bytes = 0; }
      page.push(row);
      bytes += size;
    }
  }
  if (page.length) yield page;
}
