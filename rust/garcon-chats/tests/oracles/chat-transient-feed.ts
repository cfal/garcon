import { BashToolUseMessage } from '../../../../common/chat-types.ts';
import { ChatTransientFeedStore } from '../../../../server/controller/chats/chat-transient-feed.ts';

const chatId = '1000000000000001';
const viewId = 'view-1';
const at = '2026-08-11T00:00:00.000Z';
const feed = new ChatTransientFeedStore('server-1');
const emit = (value: unknown) => console.log(JSON.stringify(value));

function request(permissionOccurrenceId: string, runId: string, ordinal: number, reason?: string) {
  const applied = feed.apply({
    type: 'permission',
    chatId,
    viewId,
    runId,
    row: {
      kind: 'permission-requested',
      ordinal,
      at,
      providerMeta: null,
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId,
        requestedTool: new BashToolUseMessage(at, `tool-${permissionOccurrenceId}`, 'bun test'),
        options: [],
        ...(reason === undefined ? {} : { reason }),
      },
    },
  });
  emit(applied.kind === 'mutation' ? applied.value : null);
}

emit(feed.snapshot({ chatId, transcriptViewId: viewId }));
emit(feed.currentSnapshot(chatId));
request('Z', 'run-1', 3, 'Synthetic permission reason');
request('a', 'run-2', 3);
const control = { chatId, viewId, runId: 'run-1', permissionOccurrenceId: 'Z' };
emit(feed.applyPermissionActionability({ control, actionability: 'claimed' }));
emit(feed.currentSnapshot(chatId));
const ended = feed.apply({
  type: 'run-ended',
  chatId,
  viewId,
  runId: 'run-1',
  row: { kind: 'run-ended', ordinal: 4, at, providerMeta: null, outcome: 'finished', origin: 'provider' },
});
emit(ended.kind === 'mutation' ? ended.value : null);
emit(feed.applyPermissionActionability({ control, actionability: 'actionable' }));
emit(feed.currentSnapshot(chatId));
feed.apply({
  type: 'view-replaced',
  chatId,
  previousViewId: viewId,
  view: { viewId: 'view-2', createdAt: at, contentStartOrdinal: 1 },
});
emit(feed.currentSnapshot(chatId));
