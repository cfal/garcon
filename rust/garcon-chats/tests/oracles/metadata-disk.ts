import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessage } from '../../../../common/chat-types.js';
import { carryOverRevision } from '../../../../server/controller/chats/carryover/segments.ts';
import { ChatListProjector } from '../../../../server/controller/chats/chat-list-projector.ts';
import { MetadataIndex } from '../../../../server/controller/chats/metadata-store.ts';
import { ChatRegistry } from '../../../../server/controller/chats/store.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

const LOCAL = '1783725900000200';
const REMOTE = '1783725900000201';
const EXECUTOR = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const EARLY = '2026-07-10T08:00:00.000Z';
const LATE = '2026-07-10T09:00:00.000Z';
const FIRST = '  First title  \nLong first message';
const LAST = 'Last line\nSecond line';

const [mode, workspace] = process.argv.slice(2);
if (!workspace) throw new Error('Workspace required');
const registry = new ChatRegistry(workspace);
await registry.init();
if (mode === 'write') {
  for (const id of [LOCAL, REMOTE]) {
    registry.addChat({ id, agentId: 'codex', agentOwnershipEpoch: 'fixture-epoch', model: 'fixture-model',
      projectPath: '/workspace/project', tags: ['review', 'review', 'work'],
      executorId: id === LOCAL ? 'local' : EXECUTOR, parentChatId: id === LOCAL ? null : LOCAL,
      preambleSelection: { revision: 0, orderedPreambleIds: [] }, lineage: null });
  }
  await registry.updateChat(LOCAL, { lastReadAt: EARLY }, { flush: true });
} else if (mode !== 'inspect') {
  throw new Error('Expected write or inspect');
}

const view = (chatId: string) => `view-${chatId}`;
const metadataPath = join(workspace, 'chat-metadata.json');
const metadata = new MetadataIndex(registry, {
  getExistingTranscriptViewId: view,
  getExistingTranscriptPreview: (_entry, chatId) => chatId === REMOTE ? {
    preview: { createdAt: EARLY, lastActivity: LATE, firstMessage: 'From ledger', lastMessage: 'Ledger tail' },
  } : null,
}, { revision: carryOverRevision }, { metadataPath });
await metadata.init();
if (mode === 'write') {
  metadata.updateFromAppendedMessages(LOCAL, view(LOCAL), [
    { type: 'user-message', timestamp: EARLY, content: FIRST },
    { type: 'assistant-message', timestamp: LATE, content: LAST },
  ] satisfies ChatMessage[]);
}
await metadata.repair();
await metadata.flush();
await metadata.close();

const projector = new ChatListProjector({ registry, metadata,
  settings: {
    getPinnedChatIds: () => [LOCAL], getNormalChatIds: () => [LOCAL, REMOTE],
    getArchivedChatIds: () => [LOCAL], getChatName: (id) => id === LOCAL ? '  \nIgnored title' : null,
  },
  processing: { phase: (id) => id === LOCAL ? 'reconnecting' : null },
  transientFeeds: { hasPendingUserAction: (id) => id === LOCAL },
  canReloadFromNativeHistory: (id) => id === REMOTE,
});
console.log(JSON.stringify({
  file: await readFile(metadataPath, 'utf8'),
  all: JSON.stringify(Object.fromEntries(metadata.listAllChatMetadata())),
  summary: JSON.stringify(projector.buildSummary(LOCAL)),
  list: JSON.stringify(Object.fromEntries(projector.buildMany(Object.entries(registry.listAllChats())))),
}));
