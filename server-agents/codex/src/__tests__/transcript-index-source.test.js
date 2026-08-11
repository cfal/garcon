import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '@garcon/common/chat-types';
import { agentOwnershipEpoch } from '@garcon/server-agent-interface';
import { AgentProjectionJournal } from '@garcon/server-agent-common/transcript-projection/journal';
import { agentTranscriptEntryId } from '@garcon/server-agent-common/transcript-projection/identity';
import moduleDefinition from '../transcript-index-source.ts';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

describe('Codex transcript index source', () => {
  it('indexes the normalized projection journal without opening Codex history', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-projection-index-'));
    try {
      const ownership = agentOwnershipEpoch('owner-1');
      const journal = await AgentProjectionJournal.open({
        directory,
        chatId: 'chat-1',
        agentOwnershipEpoch: ownership,
        bootstrapEntries: [{
          id: agentTranscriptEntryId('entry-1'),
          lifetime: 'durable',
          source: { namespace: 'codex:rollout', itemId: 'item-1', subrowId: 'message' },
          provenance: null,
          message: new UserMessage('2026-07-20T00:00:00.000Z', 'journal authority'),
        }],
      });
      const source = moduleDefinition.create({ agentId: 'codex', logger });
      const opened = await source.open({
        source: journal.indexSource('codex'),
        previous: null,
        signal: new AbortController().signal,
        maxEntriesPerBatch: 10,
      });

      expect(moduleDefinition.apiVersion).toBe(2);
      expect(opened.kind).toBe('snapshot');
      const entries = [];
      if (opened.kind === 'snapshot') {
        for await (const batch of opened.batches) entries.push(...batch);
      }
      expect(entries.map((entry) => [
        entry.ordinal,
        entry.entry.id,
        entry.entry.message.type,
      ])).toEqual([[1, 'entry-1', 'user-message']]);
      await source.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
