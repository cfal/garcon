import { expect, test } from 'bun:test';
import { BackgroundTaskToolUseMessage, ScheduleToolUseMessage, ToolResultMessage } from '@garcon/common/chat-types';
import { storedProviderRows, storedRow } from '../../../ledger/__tests__/stored-rows.js';
import { transcriptViewId } from '../../../ledger/contracts.js';
import { runTranscriptRenderingTask } from '../../transcript-rendering/tasks.js';
import { decodeShareSnapshot } from '../snapshot-format.js';

test('a share counts only public frozen messages when recording the binding boundary', () => {
  const viewId = transcriptViewId('view-1');
  const at = '2026-01-01T00:00:00Z';
  const rows = storedProviderRows([new ScheduleToolUseMessage(at, 'reused', { action: 'list' }),
    new BackgroundTaskToolUseMessage(at, 'reused', 'list'), new ToolResultMessage(at, 'reused', { raw: 'Task list' }, false)], viewId);
  const hidden = storedRow({ kind: 'session', at, viewId, ordinal: 2, providerMeta: null,
    detail: { agentSessionId: 'session', nativeSession: null, nativeSeedReceipt: null } });
  const header = { shareToken: 'fixture', chatId: 'chat', title: 'Share', agentId: 'antigravity', model: 'fixture', projectPath: '/project', sharedAt: at };
  const rendered = runTranscriptRenderingTask({ kind: 'render-share-snapshot', header, contentStartOrdinal: 3 },
    [rows[0], hidden, { ...rows[1], ordinal: 3 }, { ...rows[2], ordinal: 4 }]);
  const stored = decodeShareSnapshot(header.shareToken, new TextDecoder().decode(rendered.snapshot));
  expect(stored?.header).toMatchObject({ messageCount: 3, frozenMessageCount: 1 });
  expect(stored?.messages.map(line => JSON.parse(line).toolId)).toEqual(['reused', 'reused', 'reused']);
});
