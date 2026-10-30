import { describe, expect, it, mock } from 'bun:test';
import { AssistantMessage } from '../../../../common/chat-types.ts';
import { createTranscriptEventFanout } from '../event-fanout.ts';
import { transcriptViewId } from '../contracts.ts';

const at = '2026-08-12T00:00:00.000Z';

function fanoutHarness(schedule) {
  const broadcast = mock(() => undefined);
  const publishTranscript = mock(() => undefined);
  const updateMetadata = mock(() => undefined);
  const fanout = createTranscriptEventFanout({
    chatExists: () => true,
    schedule,
    broadcast,
    publishTranscript,
    updateMetadata,
    replaceMetadata: mock(() => undefined),
    resendCandidates: () => [{ ordinal: 1, content: 'prompt', attachmentNames: [] }],
  });
  return { fanout, broadcast, publishTranscript, updateMetadata };
}

describe('transcript event fanout', () => {
  it('schedules committed rows before publishing their body and body-free summary', () => {
    const tasks = [];
    const { fanout, broadcast, publishTranscript, updateMetadata } = fanoutHarness(
      (_chatId, task) => tasks.push(task),
    );
    const viewId = transcriptViewId('view-1');

    fanout({
      type: 'rows',
      chatId: 'chat-1',
      viewId,
      rows: [{
        kind: 'provider-row',
        ordinal: 2,
        at,
        message: new AssistantMessage(at, 'answer\nmore'),
        providerMeta: null,
      }],
    });

    expect(publishTranscript).not.toHaveBeenCalled();
    tasks[0]();
    expect(updateMetadata).toHaveBeenCalledWith('chat-1', 'view-1', [
      expect.objectContaining({ content: 'answer\nmore' }),
    ]);
    expect(broadcast).not.toHaveBeenCalled();
    const [body, summary] = publishTranscript.mock.calls[0];
    const activity = {
      preview: { content: 'answer', timestamp: at },
      lastActivityAt: at,
      planModeEntered: false,
      planExitRequests: [],
    };
    expect(body).toMatchObject({
      type: 'chat-messages',
      chatId: 'chat-1',
      transcriptViewId: viewId,
      firstOrdinal: 2,
      lastOrdinal: 2,
      resendCandidates: [{ ordinal: 1, content: 'prompt', attachmentNames: [] }],
    });
    expect(body).not.toHaveProperty('activity');
    expect(JSON.parse(JSON.stringify(summary))).toEqual({
      type: 'chat-transcript-advanced',
      chatId: 'chat-1',
      transcriptViewId: viewId,
      firstOrdinal: 2,
      lastOrdinal: 2,
      activity,
    });
  });

  it('publishes lifecycle-only commits without inventing rendered messages', () => {
    const { fanout, publishTranscript, updateMetadata } = fanoutHarness((_chatId, task) => task());

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

    const [body, summary] = publishTranscript.mock.calls[0];
    expect(body).toMatchObject({ messages: [], turnId: 'run-1' });
    expect(summary).toMatchObject({ firstOrdinal: 1, lastOrdinal: 1, activity: { preview: null } });
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('broadcasts view replacement to every socket', async () => {
    const tasks = [];
    const { fanout, broadcast, publishTranscript } = fanoutHarness((_chatId, task) => tasks.push(task));

    fanout({
      type: 'view-replaced',
      chatId: 'chat-1',
      previousViewId: transcriptViewId('view-1'),
      view: { viewId: transcriptViewId('view-2') },
    });
    await tasks[0]();

    expect(publishTranscript).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat-transcript-replaced',
      transcriptViewId: 'view-2',
    }));
  });
});
