import { describe, expect, it, mock } from 'bun:test';
import { ProjectionCaptureService } from '../projection-capture.js';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';

const TS = '2026-06-01T00:00:00.000Z';

function projection(total, durableCount = total) {
  return {
    epoch: 'stream-epoch-1',
    contentEpoch: 'content-epoch-1',
    total,
    durableCount,
    durableRevision: `durable-rev-${durableCount}`,
    stateRevision: `state-rev-${total}`,
  };
}

function integrationFor({ state, entries }) {
  return {
    transcript: {
      openSegment: mock(async () => ({
        kind: 'ready',
        value: {
          checkpoint: {
            chatId: 'chat-1',
            agentOwnershipEpoch: 'ownership-1',
            offset: '1',
            projection: state,
          },
          idle: true,
        },
      })),
      loadPage: mock(async ({ beforeOrdinal, limit, expectedProjection }) => {
        expect(expectedProjection).toBe(state);
        const end = beforeOrdinal === null ? entries.length : beforeOrdinal - 1;
        const start = Math.max(0, end - limit);
        return {
          kind: 'ready',
          page: {
            projection: state,
            entries: entries.slice(start, end),
            firstOrdinal: start + 1,
            hasMore: start > 0,
          },
        };
      }),
    },
  };
}

const request = (integration) => ({
  chatId: 'chat-1',
  integration,
  reference: { chatId: 'chat-1', agentOwnershipEpoch: 'ownership-1' },
  signal: new AbortController().signal,
});

describe('ProjectionCaptureService', () => {
  it('captures the durable ledger in one pinned pass', async () => {
    const entries = [
      { message: new UserMessage(TS, 'prompt') },
      { message: new AssistantMessage(TS, 'reply') },
    ];
    const integration = integrationFor({ state: projection(2), entries });

    const captured = await new ProjectionCaptureService().loadStable(request(integration));

    expect(captured.revision).toBe('durable-rev-2');
    expect(captured.messages.map((message) => message.content)).toEqual(['prompt', 'reply']);
    expect(integration.transcript.openSegment).toHaveBeenCalledTimes(1);
  });

  it('refuses to capture while an admitted input has not settled', async () => {
    const integration = integrationFor({
      state: projection(2, 1),
      entries: [{ message: new UserMessage(TS, 'prompt') }],
    });

    await expect(new ProjectionCaptureService().loadStable(request(integration)))
      .rejects.toMatchObject({ code: 'TRANSCRIPT_NOT_YET_PERSISTED', status: 409 });
    expect(integration.transcript.loadPage).not.toHaveBeenCalled();
  });

  it('rejects a revision drift discovered before commit', async () => {
    const integration = integrationFor({ state: projection(3), entries: [] });

    await expect(new ProjectionCaptureService().assertRevision({
      integration,
      reference: { chatId: 'chat-1', agentOwnershipEpoch: 'ownership-1' },
      expectedRevision: 'durable-rev-2',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'TRANSCRIPT_NOT_YET_PERSISTED' });

    await expect(new ProjectionCaptureService().assertRevision({
      integration,
      reference: { chatId: 'chat-1', agentOwnershipEpoch: 'ownership-1' },
      expectedRevision: 'durable-rev-3',
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();
  });

  it('maps deferred projections to a retryable source failure', async () => {
    const integration = {
      transcript: {
        openSegment: mock(async () => ({ kind: 'deferred', retry: 'execution-settled' })),
        loadPage: mock(async () => ({ kind: 'deferred', retry: 'execution-settled' })),
      },
    };

    await expect(new ProjectionCaptureService().loadStable(request(integration)))
      .rejects.toMatchObject({ code: 'SOURCE_TRANSCRIPT_UNAVAILABLE', retryable: true });
  });
});
