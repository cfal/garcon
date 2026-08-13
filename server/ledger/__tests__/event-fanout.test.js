import { describe, expect, it, mock } from 'bun:test';
import { AssistantMessage } from '../../../common/chat-types.ts';
import { createTranscriptEventFanout } from '../event-fanout.ts';
import { transcriptViewId } from '../contracts.ts';

const at = '2026-08-12T00:00:00.000Z';

describe('transcript event fanout', () => {
  it('schedules committed rows before broadcasting their view-qualified append', () => {
    const tasks = [];
    const broadcast = mock(() => undefined);
    const updateMetadata = mock(() => undefined);
    const markSearchDirty = mock(() => undefined);
    const fanout = createTranscriptEventFanout({
      chatExists: () => true,
      schedule: (_chatId, task) => tasks.push(task),
      broadcast,
      updateMetadata,
      markSearchDirty,
      resendCandidates: () => [{ ordinal: 1, content: 'prompt', attachmentNames: [] }],
    });
    const viewId = transcriptViewId('view-1');

    fanout({
      type: 'rows',
      chatId: 'chat-1',
      viewId,
      rows: [{
        kind: 'provider-row',
        ordinal: 2,
        at,
        message: new AssistantMessage(at, 'answer'),
        providerMeta: null,
      }],
    });

    expect(broadcast).not.toHaveBeenCalled();
    tasks[0]();
    expect(updateMetadata).toHaveBeenCalledWith('chat-1', [
      expect.objectContaining({ content: 'answer' }),
    ]);
    expect(markSearchDirty).toHaveBeenCalledWith('chat-1');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat-messages',
      chatId: 'chat-1',
      transcriptViewId: viewId,
      firstOrdinal: 2,
      lastOrdinal: 2,
      resendCandidates: [{ ordinal: 1, content: 'prompt', attachmentNames: [] }],
    }));
  });

  it('broadcasts lifecycle-only commits without inventing rendered messages', () => {
    const broadcast = mock(() => undefined);
    const fanout = createTranscriptEventFanout({
      chatExists: () => true,
      schedule: (_chatId, task) => task(),
      broadcast,
      updateMetadata: () => undefined,
      markSearchDirty: () => undefined,
      resendCandidates: () => [],
    });

    fanout({
      type: 'run-ended',
      chatId: 'chat-1',
      viewId: transcriptViewId('view-1'),
      runId: 'run-1',
      row: {
        kind: 'run-ended',
        ordinal: 1,
        at,
        outcome: 'finished',
        origin: 'provider',
        providerMeta: null,
      },
    });

    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      messages: [],
      turnId: 'run-1',
    }));
  });
});
