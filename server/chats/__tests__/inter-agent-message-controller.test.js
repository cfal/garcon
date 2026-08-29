import { describe, expect, it, mock } from 'bun:test';
import { DomainError } from '../../lib/domain-error.ts';
import { KeyedPromiseLock } from '../../lib/keyed-lock.ts';
import { InterAgentMessageController } from '../inter-agent-message-controller.ts';

const SOURCE_CHAT_ID = '1787974832309199';
const TARGET_CHAT_ID = '1787974832309200';
const SECOND_TARGET_CHAT_ID = '1787974832309201';
const THIRD_TARGET_CHAT_ID = '1787974832309202';
const MISSING_TARGET_CHAT_ID = '1787974832309203';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for inter-agent message state');
}

function request(overrides = {}) {
  return {
    sourceChatId: SOURCE_CHAT_ID,
    sourceViewId: 'source-view',
    requestAt: '2026-08-29T00:00:00.000Z',
    recipients: [TARGET_CHAT_ID],
    hideSender: false,
    body: 'message body',
    ...overrides,
  };
}

function createFixture(overrides = {}) {
  const chats = overrides.chats ?? new Set([
    SOURCE_CHAT_ID,
    TARGET_CHAT_ID,
    SECOND_TARGET_CHAT_ID,
    THIRD_TARGET_CHAT_ID,
  ]);
  const registry = {
    getChat: mock((chatId) => chats.has(chatId) ? { id: chatId } : null),
  };
  const adoption = {
    ensure: mock(async (chatId) => ({ viewId: `view-${chatId}` })),
    ...overrides.adoption,
  };
  const execution = {
    deliverInterAgentControlInput: mock(async () => 'delivered'),
    ...overrides.execution,
  };
  const notices = {
    appendNotice: mock(() => undefined),
    ...overrides.notices,
  };
  const dispositions = [];
  const errors = [];
  const controller = new InterAgentMessageController({
    registry,
    adoption,
    execution,
    notices,
    chatMutationLock: overrides.chatMutationLock ?? new KeyedPromiseLock(),
    isEnabled: overrides.isEnabled ?? (() => true),
    onDisposition: (event) => dispositions.push(event),
    onError: (error, context) => errors.push({ error, context }),
  });
  return { controller, registry, adoption, execution, notices, dispositions, errors };
}

function sourceNotices(fixture) {
  return fixture.notices.appendNotice.mock.calls.filter(([chatId]) => chatId === SOURCE_CHAT_ID);
}

describe('InterAgentMessageController', () => {
  it('records a disabled outcome without adopting or delivering to targets', async () => {
    const fixture = createFixture({ isEnabled: () => false });

    fixture.controller.request(request({ recipients: [TARGET_CHAT_ID, SECOND_TARGET_CHAT_ID] }));
    await waitFor(() => sourceNotices(fixture).length === 1);

    expect(fixture.adoption.ensure).not.toHaveBeenCalled();
    expect(fixture.execution.deliverInterAgentControlInput).not.toHaveBeenCalled();
    expect(sourceNotices(fixture)[0][2]).toMatchObject({
      content: `Failed: ${TARGET_CHAT_ID} (agent messaging is disabled)\nFailed: ${SECOND_TARGET_CHAT_ID} (agent messaging is disabled)\n\nmessage body`,
      detail: {
        results: [
          { chatId: TARGET_CHAT_ID, status: 'failed', reason: 'disabled' },
          { chatId: SECOND_TARGET_CHAT_ID, status: 'failed', reason: 'disabled' },
        ],
      },
    });
  });

  it('delivers the exact visible-sender envelope and records target then source notices', async () => {
    const fixture = createFixture();

    fixture.controller.request(request());
    await waitFor(() => sourceNotices(fixture).length === 1);

    expect(fixture.execution.deliverInterAgentControlInput).toHaveBeenCalledWith(
      TARGET_CHAT_ID,
      {
        content: `<garcon-message from="${SOURCE_CHAT_ID}">\nmessage body\n</garcon-message>`,
        transcriptViewId: `view-${TARGET_CHAT_ID}`,
        createdAt: '2026-08-29T00:00:00.000Z',
        receipt: {
          title: `Message from chat ${SOURCE_CHAT_ID}`,
          content: 'message body',
          detail: { type: 'inter-agent-message-received', fromChatId: SOURCE_CHAT_ID },
        },
      },
      expect.any(AbortSignal),
    );
    expect(fixture.notices.appendNotice.mock.calls).toEqual([
      [
        TARGET_CHAT_ID,
        `view-${TARGET_CHAT_ID}`,
        {
          title: `Message from chat ${SOURCE_CHAT_ID}`,
          content: 'message body',
          detail: { type: 'inter-agent-message-received', fromChatId: SOURCE_CHAT_ID },
          at: '2026-08-29T00:00:00.000Z',
        },
      ],
      [
        SOURCE_CHAT_ID,
        'source-view',
        {
          title: 'Inter-agent message',
          content: `Delivered: ${TARGET_CHAT_ID}\n\nmessage body`,
          detail: {
            type: 'inter-agent-message-outcome',
            results: [{ chatId: TARGET_CHAT_ID, status: 'delivered' }],
          },
          at: '2026-08-29T00:00:00.000Z',
        },
      ],
    ]);
  });

  it('hides sender identity and reports process-ephemeral queue admission honestly', async () => {
    const fixture = createFixture({
      execution: { deliverInterAgentControlInput: mock(async () => 'queued') },
    });

    fixture.controller.request(request({ hideSender: true }));
    await waitFor(() => sourceNotices(fixture).length === 1);

    expect(fixture.execution.deliverInterAgentControlInput.mock.calls[0][1]).toEqual({
      content: '<garcon-message>\nmessage body\n</garcon-message>',
      transcriptViewId: `view-${TARGET_CHAT_ID}`,
      createdAt: '2026-08-29T00:00:00.000Z',
      receipt: {
        title: 'Inter-agent message',
        content: 'message body',
        detail: { type: 'inter-agent-message-received', fromChatId: null },
      },
    });
    expect(fixture.notices.appendNotice).toHaveBeenCalledTimes(1);
    expect(sourceNotices(fixture)[0][2]).toMatchObject({
      content: `Queued: ${TARGET_CHAT_ID} (pending delivery is not retained across server restart)\n\nmessage body`,
      detail: {
        results: [{ chatId: TARGET_CHAT_ID, status: 'queued' }],
      },
    });
  });

  it('fans out independently and preserves recipient order in one partial outcome', async () => {
    const fixture = createFixture({
      execution: {
        deliverInterAgentControlInput: mock(async (chatId) => {
          if (chatId === TARGET_CHAT_ID) return 'delivered';
          if (chatId === SECOND_TARGET_CHAT_ID) {
            throw new DomainError('CONTROL_INPUT_QUEUE_FULL', 'full');
          }
          throw new DomainError('STEER_OUTCOME_UNKNOWN', 'unknown');
        }),
      },
    });
    const recipients = [
      SECOND_TARGET_CHAT_ID,
      SOURCE_CHAT_ID,
      TARGET_CHAT_ID,
      MISSING_TARGET_CHAT_ID,
      THIRD_TARGET_CHAT_ID,
    ];

    fixture.controller.request(request({ recipients }));
    await waitFor(() => sourceNotices(fixture).length === 1);

    expect(sourceNotices(fixture)[0][2].detail.results).toEqual([
      { chatId: SECOND_TARGET_CHAT_ID, status: 'failed', reason: 'queue-full' },
      { chatId: SOURCE_CHAT_ID, status: 'failed', reason: 'self-send' },
      { chatId: TARGET_CHAT_ID, status: 'delivered' },
      { chatId: MISSING_TARGET_CHAT_ID, status: 'failed', reason: 'target-not-found' },
      { chatId: THIRD_TARGET_CHAT_ID, status: 'failed', reason: 'delivery-unknown' },
    ]);
    expect(fixture.execution.deliverInterAgentControlInput).toHaveBeenCalledTimes(3);
  });

  it('records every recipient when one target lock fails unexpectedly', async () => {
    const lockError = new Error('target lock failed');
    const chatMutationLock = {
      runExclusive: mock((key, work) => key === `chat:${TARGET_CHAT_ID}`
        ? Promise.reject(lockError)
        : work()),
    };
    const fixture = createFixture({ chatMutationLock });

    fixture.controller.request(request({
      recipients: [TARGET_CHAT_ID, SECOND_TARGET_CHAT_ID],
    }));
    await waitFor(() => sourceNotices(fixture).length === 1);

    expect(sourceNotices(fixture)[0][2].detail.results).toEqual([
      { chatId: TARGET_CHAT_ID, status: 'failed', reason: 'delivery-failed' },
      { chatId: SECOND_TARGET_CHAT_ID, status: 'delivered' },
    ]);
    expect(fixture.errors).toContainEqual({
      error: lockError,
      context: {
        sourceChatId: SOURCE_CHAT_ID,
        targetChatId: TARGET_CHAT_ID,
        phase: 'target-delivery',
      },
    });
  });

  it('classifies adoption failure and provider rejection without target receipts', async () => {
    const fixture = createFixture({
      adoption: {
        ensure: mock(async (chatId) => {
          if (chatId === TARGET_CHAT_ID) throw new Error('adoption failed');
          return { viewId: `view-${chatId}` };
        }),
      },
      execution: {
        deliverInterAgentControlInput: mock(async () => {
          throw new DomainError('STEER_PROVIDER_REJECTED', 'rejected');
        }),
      },
    });

    fixture.controller.request(request({ recipients: [TARGET_CHAT_ID, SECOND_TARGET_CHAT_ID] }));
    await waitFor(() => sourceNotices(fixture).length === 1);

    expect(sourceNotices(fixture)[0][2].detail.results).toEqual([
      { chatId: TARGET_CHAT_ID, status: 'failed', reason: 'target-unavailable' },
      { chatId: SECOND_TARGET_CHAT_ID, status: 'failed', reason: 'provider-rejected' },
    ]);
    expect(fixture.notices.appendNotice).toHaveBeenCalledTimes(1);
    expect(fixture.errors).toHaveLength(1);
    expect(fixture.errors[0].context).toMatchObject({
      targetChatId: TARGET_CHAT_ID,
      phase: 'target-adoption',
    });
  });

  it('keeps an accepted delivery successful when its target receipt cannot be stored', async () => {
    const receiptError = new Error('receipt failed');
    const fixture = createFixture({
      notices: {
        appendNotice: mock((chatId) => {
          if (chatId === TARGET_CHAT_ID) throw receiptError;
        }),
      },
    });

    fixture.controller.request(request());
    await waitFor(() => sourceNotices(fixture).length === 1);

    expect(sourceNotices(fixture)[0][2].detail.results).toEqual([
      { chatId: TARGET_CHAT_ID, status: 'delivered' },
    ]);
    expect(fixture.errors).toEqual([{
      error: receiptError,
      context: {
        sourceChatId: SOURCE_CHAT_ID,
        targetChatId: TARGET_CHAT_ID,
        phase: 'target-receipt',
      },
    }]);
  });

  it('serializes separate commands to one target without deduplicating them', async () => {
    const first = deferred();
    let calls = 0;
    const fixture = createFixture({
      execution: {
        deliverInterAgentControlInput: mock(() => {
          calls += 1;
          return calls === 1 ? first.promise : Promise.resolve('queued');
        }),
      },
    });

    fixture.controller.request(request({ body: 'first' }));
    fixture.controller.request(request({ body: 'second' }));
    await waitFor(() => fixture.execution.deliverInterAgentControlInput.mock.calls.length === 1);
    expect(sourceNotices(fixture)).toHaveLength(0);

    first.resolve('queued');
    await waitFor(() => fixture.execution.deliverInterAgentControlInput.mock.calls.length === 2);
    await waitFor(() => sourceNotices(fixture).length === 2);

    expect(fixture.execution.deliverInterAgentControlInput.mock.calls.map((call) => call[1].receipt.content))
      .toEqual(['first', 'second']);
  });

  it('aborts source reporting without retracting target-owned accepted work', async () => {
    let targetAccepted = false;
    let controller;
    const fixture = createFixture({
      execution: {
        deliverInterAgentControlInput: mock(async () => {
          targetAccepted = true;
          controller.discardSource(SOURCE_CHAT_ID);
          return 'queued';
        }),
      },
    });
    controller = fixture.controller;

    controller.request(request());
    await waitFor(() => targetAccepted);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(targetAccepted).toBe(true);
    expect(sourceNotices(fixture)).toHaveLength(0);
  });
});
