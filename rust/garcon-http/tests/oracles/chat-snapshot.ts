import { AssistantMessage } from '../../../../common/chat-types.js';
import { emptyStoredChatExecutionControl } from '../../../../server/controller/chat-execution/control-state.js';
import { ChatListProjector } from '../../../../server/controller/chats/chat-list-projector.js';
import { ChatTransientFeedStore } from '../../../../server/controller/chats/chat-transient-feed.js';
import { TranscriptHistoryUnavailableError } from '../../../../server/controller/chats/errors.js';
import { normalizeChatRegistryEntry } from '../../../../server/controller/chats/registry-entry-codec.js';
import { createChatSnapshotRoutes } from '../../../../server/controller/routes/chat-snapshot.js';

const chatId = '1000000000000002';
let executorId: string | null | undefined;
const projector = new ChatListProjector({
  registry: {
    getChat(id) {
      if (id !== chatId) return null;
      return normalizeChatRegistryEntry({
        agentId: 'shell',
        agentOwnershipEpoch: 'fixture-epoch',
        agentSettingsById: {},
        projectPath: '/srv/seeded-project',
        tags: ['synthetic'],
        carryOverSegments: [],
        nativeSeedReceipt: null,
        carryOverMigrationQuarantine: null,
        parentChatId: null,
        lineage: null,
        ...(executorId === undefined ? {} : { executorId }),
      }, id);
    },
  },
  settings: {
    getPinnedChatIds: () => [],
    getNormalChatIds: () => [],
    getArchivedChatIds: () => [],
    getChatName: () => 'Synthetic title',
  },
  metadata: {
    getChatMetadata: () => null,
    listAllChatMetadata: () => new Map(),
    getRunOutcome: () => null,
  },
  processing: { phase: () => 'running' },
  transientFeeds: { hasPendingUserAction: () => false },
  canReloadFromNativeHistory: () => false,
});

const at = '2001-09-09T01:46:40.000Z';
const instance = 'fixture-instance';
const control = emptyStoredChatExecutionControl(instance);
control.entries.push({
  id: 'fixture-entry', content: 'Queued text', kind: 'turn', revision: 1,
  createdAt: at, updatedAt: at, status: 'queued', images: [],
});
const route = createChatSnapshotRoutes({
  summaries: projector,
  execution: { readChatExecutionControl: async () => control },
  chatViews: {
    async page(_id, limit) {
      if (limit === 2) {
        throw new TranscriptHistoryUnavailableError({
          kind: 'degraded', errorCode: 'LEDGER_FENCED', retryable: false,
        });
      }
      if (limit !== 1) throw new Error('Unexpected page limit');
      return {
        transcriptViewId: 'fixture-view',
        messages: [{ ordinal: 1, message: new AssistantMessage(at, 'Synthetic transcript') }],
        lastOrdinal: 1, pageOldestOrdinal: 1, pageNewestOrdinal: 1,
        nextBeforeOrdinal: null, hasMore: false,
      };
    },
  },
  transientFeeds: new ChatTransientFeedStore(instance),
  now: () => new Date(at),
})['/api/v1/chats/snapshot']!.GET!;

for (executorId of [undefined, null, 'local']) {
  for (const limit of [0, 1, 2]) {
    const url = new URL(`http://localhost/api/v1/chats/snapshot?chatId=${chatId}&limit=${limit}`);
    const response = await route(new Request(url), url);
    if (response.status !== 200 || response.headers.get('cache-control') !== 'no-store') {
      throw new Error(`Unexpected snapshot: ${response.status} ${await response.text()}`);
    }
    console.log(await response.text());
  }
}
