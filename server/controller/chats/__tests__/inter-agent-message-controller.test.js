import { describe, expect, it, mock, spyOn } from 'bun:test';
import { DomainError, ProjectUnavailableError } from '../../../common/domain-error.ts';
import { INTERACTIVE_EXECUTOR_WAIT_MS } from '../../../common/interactive-deadline.ts';
import { KeyedPromiseLock } from '../../../common/keyed-lock.ts';
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
    offerServerControlInput: mock(async () => ({ kind: 'delivered' })),
    queueServerControlInput: mock(async () => 'queued'),
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
  // A message queued behind another operation on the target's lock gives up
  // waiting for a reconnecting executor in turn, so a Stop behind both is not
  // held for two budgets.
  it('starts an offer\'s interactive deadline when it asks for the target\'s lock', async () => {
    let now = 1_000;
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const lock = new KeyedPromiseLock();
      const held = deferred();
      const holding = lock.runExclusive(`chat:${TARGET_CHAT_ID}`, () => held.promise);
      const fixture = createFixture({ chatMutationLock: lock });

      fixture.controller.request(request());
      await Bun.sleep(20);
      now = 30_000;
      held.resolve();
      await holding;
      await waitFor(() => sourceNotices(fixture).length === 1);

      expect(fixture.execution.offerServerControlInput.mock.calls[0][3]).toBe(1_000 + INTERACTIVE_EXECUTOR_WAIT_MS);
    } finally {
      clock.mockRestore();
    }
  });

  it('records a disabled outcome without adopting or delivering to targets', async () => {
    const fixture = createFixture({ isEnabled: () => false });

    fixture.controller.request(request({ recipients: [TARGET_CHAT_ID, SECOND_TARGET_CHAT_ID] }));
    await waitFor(() => sourceNotices(fixture).length === 1);

    expect(fixture.adoption.ensure).not.toHaveBeenCalled();
    expect(fixture.execution.offerServerControlInput).not.toHaveBeenCalled();
    expect(sourceNotices(fixture)[0][2]).toMatchObject({
      content: 'message body',
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

    expect(fixture.execution.offerServerControlInput).toHaveBeenCalledWith(
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
      expect.any(Number),
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
          content: 'message body',
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
      execution: { offerServerControlInput: mock(async () => ({ kind: 'queued' })) },
    });

    fixture.controller.request(request({ hideSender: true }));
    await waitFor(() => sourceNotices(fixture).length === 1);

    expect(fixture.execution.offerServerControlInput.mock.calls[0][1]).toEqual({
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
      content: 'message body',
      detail: {
        results: [{ chatId: TARGET_CHAT_ID, status: 'queued' }],
      },
    });
  });

  it('fans out independently and preserves recipient order in one partial outcome', async () => {
    const fixture = createFixture({
      execution: {
        offerServerControlInput: mock(async (chatId) => {
          if (chatId === TARGET_CHAT_ID) return { kind: 'delivered' };
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
    expect(fixture.execution.offerServerControlInput).toHaveBeenCalledTimes(3);
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
        offerServerControlInput: mock(async () => {
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

  it('classifies project admission failure as target unavailable', async () => {
    const fixture = createFixture({
      execution: {
        offerServerControlInput: mock(async () => {
          throw new ProjectUnavailableError('/workspace/project', 'not-found');
        }),
      },
    });

    fixture.controller.request(request());
    await waitFor(() => sourceNotices(fixture).length === 1);

    expect(sourceNotices(fixture)[0][2].detail.results).toEqual([
      { chatId: TARGET_CHAT_ID, status: 'failed', reason: 'target-unavailable' },
    ]);
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
        offerServerControlInput: mock(() => {
          calls += 1;
          return calls === 1 ? first.promise : Promise.resolve({ kind: 'queued' });
        }),
      },
    });

    fixture.controller.request(request({ body: 'first' }));
    fixture.controller.request(request({ body: 'second' }));
    await waitFor(() => fixture.execution.offerServerControlInput.mock.calls.length === 1);
    expect(sourceNotices(fixture)).toHaveLength(0);

    first.resolve({ kind: 'queued' });
    await waitFor(() => fixture.execution.offerServerControlInput.mock.calls.length === 2);
    await waitFor(() => sourceNotices(fixture).length === 2);

    expect(fixture.execution.offerServerControlInput.mock.calls.map((call) => call[1].receipt.content))
      .toEqual(['first', 'second']);
  });

  it('aborts source reporting without retracting target-owned accepted work', async () => {
    let targetAccepted = false;
    let controller;
    const fixture = createFixture({
      execution: {
        offerServerControlInput: mock(async () => {
          targetAccepted = true;
          controller.discardSource(SOURCE_CHAT_ID);
          return { kind: 'queued' };
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

  it('waits for a running turn it could not reach without holding the target lock, then queues', async () => {
    const turnSettled = deferred();
    const chatMutationLock = new KeyedPromiseLock();
    const fixture = createFixture({
      chatMutationLock,
      execution: {
        offerServerControlInput: mock(async () => ({ kind: 'after-turn', turnSettled: turnSettled.promise })),
      },
    });

    fixture.controller.request(request());
    await waitFor(() => fixture.execution.offerServerControlInput.mock.calls.length === 1);
    // Stop and permission answers for the target take this lock while the turn runs.
    await chatMutationLock.runExclusive(`chat:${TARGET_CHAT_ID}`, async () => undefined);
    expect(fixture.execution.queueServerControlInput).not.toHaveBeenCalled();

    turnSettled.resolve();
    await waitFor(() => sourceNotices(fixture).length === 1);

    expect(fixture.execution.queueServerControlInput).toHaveBeenCalledWith(
      TARGET_CHAT_ID,
      fixture.execution.offerServerControlInput.mock.calls[0][1],
      expect.any(AbortSignal),
    );
    expect(sourceNotices(fixture)[0][2].detail.results).toEqual([
      { chatId: TARGET_CHAT_ID, status: 'queued' },
    ]);
    expect(fixture.notices.appendNotice).toHaveBeenCalledTimes(1);
  });

  it('checks the target again after its running turn settles', async () => {
    const turnSettled = deferred();
    const chats = new Set([SOURCE_CHAT_ID, TARGET_CHAT_ID, SECOND_TARGET_CHAT_ID]);
    let view = 'view-before-reload';
    const fixture = createFixture({
      chats,
      adoption: { ensure: mock(async (chatId) => ({ viewId: chatId === TARGET_CHAT_ID ? 'removed' : view })) },
      execution: {
        offerServerControlInput: mock(async () => ({ kind: 'after-turn', turnSettled: turnSettled.promise })),
      },
    });

    fixture.controller.request(request({ recipients: [TARGET_CHAT_ID, SECOND_TARGET_CHAT_ID] }));
    await waitFor(() => fixture.execution.offerServerControlInput.mock.calls.length === 2);
    chats.delete(TARGET_CHAT_ID);
    view = 'view-after-reload';
    turnSettled.resolve();
    await waitFor(() => sourceNotices(fixture).length === 1);

    expect(sourceNotices(fixture)[0][2].detail.results).toEqual([
      { chatId: TARGET_CHAT_ID, status: 'failed', reason: 'target-not-found' },
      { chatId: SECOND_TARGET_CHAT_ID, status: 'queued' },
    ]);
    expect(fixture.execution.queueServerControlInput.mock.calls.map(([chatId, input]) => [chatId, input.transcriptViewId]))
      .toEqual([[SECOND_TARGET_CHAT_ID, 'view-after-reload']]);
  });

  it('keeps later messages to a target behind one waiting for its running turn', async () => {
    const turnSettled = deferred();
    let offers = 0;
    const fixture = createFixture({
      execution: {
        offerServerControlInput: mock(async () => {
          offers += 1;
          return offers === 1 ? { kind: 'after-turn', turnSettled: turnSettled.promise } : { kind: 'queued' };
        }),
      },
    });

    fixture.controller.request(request({ body: 'first' }));
    fixture.controller.request(request({ body: 'second' }));
    await waitFor(() => offers === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(offers).toBe(1);

    turnSettled.resolve();
    await waitFor(() => sourceNotices(fixture).length === 2);
    expect(fixture.execution.queueServerControlInput.mock.calls.map(([, input]) => input.receipt.content))
      .toEqual(['first']);
    expect(fixture.execution.offerServerControlInput.mock.calls.map(([, input]) => input.receipt.content))
      .toEqual(['first', 'second']);
  });

  it('abandons a message waiting for a running turn when its source is discarded', async () => {
    const fixture = createFixture({
      execution: {
        offerServerControlInput: mock(async () => ({ kind: 'after-turn', turnSettled: new Promise(() => undefined) })),
      },
    });

    fixture.controller.request(request());
    await waitFor(() => fixture.execution.offerServerControlInput.mock.calls.length === 1);
    fixture.controller.discardSource(SOURCE_CHAT_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fixture.execution.queueServerControlInput).not.toHaveBeenCalled();
    expect(sourceNotices(fixture)).toHaveLength(0);
    expect(fixture.errors).toEqual([]);
  });
});
