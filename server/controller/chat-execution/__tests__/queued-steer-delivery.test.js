import { describe, expect, it, mock } from 'bun:test';
import { DomainError } from '../../../common/domain-error.ts';
import { KeyedPromiseLock } from '../../../common/keyed-lock.ts';
import { ChatExecutionControlOperations } from '../chat-execution-control-operations.ts';
import { InMemoryChatExecutionControlRepository } from '../chat-execution-control-repository.ts';
import { ExecutionOwnership } from '../execution-ownership.ts';
import { QueueExecutionAttempt } from '../execution-attempt.ts';
import { QueuedSteerDelivery } from '../queued-steer-delivery.ts';
import { SteerInputDelivery } from '../steer-input-delivery.ts';

const CHAT_ID = 'chat-1';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function scaffold(overrides = {}) {
  let delivery;
  const locks = new KeyedPromiseLock();
  const repository = new InMemoryChatExecutionControlRepository('server-instance-test');
  const controls = new ChatExecutionControlOperations(repository, {
    runExclusive: (chatId, operation) => locks.runExclusive(chatId, operation),
    chatExists: () => true,
    unsettledQueueReceiptKeys: () => new Set(),
    // The coordinator observes every publication; most cases request passes explicitly.
    publish: (chatId, control) => {
      if (overrides.observePublications) delivery.observe(chatId, control);
    },
  }, { assertAvailable: mock(async () => undefined) }, { assertSupported: mock(() => undefined) });
  const ownership = new ExecutionOwnership();
  const attempt = new QueueExecutionAttempt({ turnId: 'turn-1', clientRequestId: 'request-1' });
  ownership.installAttempt(CHAT_ID, attempt);
  const state = { providerTarget: {} };
  const turnRunner = {
    captureSteerTarget: mock(async () => state.providerTarget),
    steerInput: overrides.steerInput ?? mock(async (_chatId, _input, _options, _target, prepareDelivery) => {
      await prepareDelivery();
      return { kind: 'accepted' };
    }),
  };
  const admitInput = mock(async () => true);
  const steerInput = new SteerInputDelivery({
    turnRunner,
    ownership,
    isShuttingDown: () => false,
    admitInput,
    discardPreparedInput: () => undefined,
  });
  const tasks = [];
  const requestDrain = mock(() => undefined);
  const resolveContent = overrides.resolveContent ?? mock(async ({ content }) => content);
  delivery = new QueuedSteerDelivery({
    controls,
    steerInput,
    resolveContent,
    canDeliver: () => true,
    requestDrain,
    trackTask: (task) => { tasks.push(task); },
  });
  let steers = 0;
  const addSteer = async (content, submission = true) => {
    steers += 1;
    return controls.createSteer(CHAT_ID, content, { key: `steer-${steers}`, entryId: `steer-${steers}` },
      submission ? { clientMessageId: `message-steer-${steers}`, transcriptViewId: 'view-1' } : undefined);
  };
  const deliver = async () => {
    delivery.request(CHAT_ID);
    while (tasks.length > 0) await tasks.shift();
  };
  return {
    controls, ownership, attempt, state, turnRunner, admitInput, requestDrain, resolveContent,
    delivery, tasks, addSteer, deliver,
  };
}

describe('QueuedSteerDelivery', () => {
  it.each([
    { images: [] },
    { images: [{ data: 'data:image/png;base64,AAAA', name: 'screen.png', mimeType: 'image/png' }] },
  ])('delivers queued steers in order and preserves the queued turn attachments: %j', async ({ images }) => {
    const f = scaffold();
    await f.controls.create(CHAT_ID, { content: 'future turn', images });
    await f.addSteer('first guidance');
    await f.addSteer('second guidance');

    await f.deliver();

    expect(f.admitInput.mock.calls.map(([, content, options]) => [content, options.clientMessageId]))
      .toEqual([
        ['first guidance', 'message-steer-1'],
        ['second guidance', 'message-steer-2'],
      ]);
    expect(f.admitInput.mock.calls[0][2]).toMatchObject({
      transcriptViewId: 'view-1',
      turnId: 'turn-1',
      commandType: 'steer',
    });
    const control = await f.controls.read(CHAT_ID);
    expect(control.entries.map(({ content, kind }) => [content, kind])).toEqual([['future turn', 'turn']]);
    expect(control.entries[0].images).toEqual(images);
    expect(control.recentlyDispatched.map((entry) => entry.entryId)).toEqual(['steer-1', 'steer-2']);
    expect(f.requestDrain).toHaveBeenCalledWith(CHAT_ID, 'queued steer consumed');
  });

  it('resolves file context for the steer it delivers', async () => {
    const resolveContent = mock(async ({ content }) => `${content}\n\nresolved context`);
    const f = scaffold({ resolveContent });
    await f.addSteer('check @notes.txt');

    await f.deliver();

    expect(resolveContent).toHaveBeenCalledWith(expect.objectContaining({
      chatId: CHAT_ID,
      content: 'check @notes.txt',
    }));
    expect(f.turnRunner.steerInput.mock.calls[0][1]).toBe('check @notes.txt\n\nresolved context');
  });

  it('keeps steers queued while the turn cannot take them or the queue is paused', async () => {
    const f = scaffold();
    f.state.providerTarget = null;
    await f.addSteer('early guidance');

    await f.deliver();
    expect(f.admitInput).not.toHaveBeenCalled();

    f.state.providerTarget = {};
    await f.controls.pause(CHAT_ID);
    await f.deliver();
    expect(f.admitInput).not.toHaveBeenCalled();

    const paused = await f.controls.read(CHAT_ID);
    await f.controls.resume(CHAT_ID, paused.pause.id);
    await f.deliver();
    expect(f.admitInput).toHaveBeenCalledTimes(1);
    expect((await f.controls.read(CHAT_ID)).entries).toEqual([]);
  });

  it('holds a steer back when the queue is paused while its delivery is prepared', async () => {
    const resolving = deferred();
    const release = deferred();
    const f = scaffold({
      resolveContent: mock(async ({ content }) => {
        resolving.resolve();
        await release.promise;
        return content;
      }),
    });
    await f.addSteer('guidance');

    f.delivery.request(CHAT_ID);
    await resolving.promise;
    await f.controls.pause(CHAT_ID);
    release.resolve();
    while (f.tasks.length > 0) await f.tasks.shift();

    expect(f.admitInput).not.toHaveBeenCalled();
    expect((await f.controls.read(CHAT_ID)).entries).toEqual([
      expect.objectContaining({ id: 'steer-1', kind: 'steer', status: 'queued' }),
    ]);
  });

  it('leaves an entry without a submission identity for the drain', async () => {
    const f = scaffold();
    await f.addSteer('direct queue steer', false);

    await f.deliver();

    expect(f.admitInput).not.toHaveBeenCalled();
    expect((await f.controls.read(CHAT_ID)).entries).toHaveLength(1);
  });

  it('releases a steer that was refused before it was recorded', async () => {
    const f = scaffold();
    await f.addSteer('guidance for a finished turn');
    const capture = f.turnRunner.captureSteerTarget.getMockImplementation();
    f.turnRunner.captureSteerTarget.mockImplementation(async () => {
      const target = await capture();
      f.attempt.markSettled();
      return target;
    });

    await f.deliver();

    expect(f.admitInput).not.toHaveBeenCalled();
    const control = await f.controls.read(CHAT_ID);
    expect(control.entries).toEqual([
      expect.objectContaining({ id: 'steer-1', kind: 'steer', status: 'queued' }),
    ]);
    expect(f.requestDrain).toHaveBeenCalledWith(CHAT_ID, 'queued steer released');
  });

  it('does not offer queued steers again to a turn that refused one before recording it', async () => {
    const f = scaffold({ observePublications: true });
    f.admitInput.mockImplementation(async () => {
      // Bounds the retries a regression would make, so the assertion below reports it.
      if (f.admitInput.mock.calls.length >= 3) f.state.providerTarget = null;
      throw new DomainError('STALE_TRANSCRIPT_VIEW', 'The transcript view changed', 409);
    });
    await f.addSteer('guidance for a replaced view');
    await f.addSteer('later guidance');

    await f.deliver();
    f.delivery.retry(CHAT_ID);
    await f.deliver();

    expect(f.admitInput).toHaveBeenCalledTimes(1);
    expect((await f.controls.read(CHAT_ID)).entries).toEqual([
      expect.objectContaining({ id: 'steer-1', kind: 'steer', status: 'queued' }),
      expect.objectContaining({ id: 'steer-2', kind: 'steer', status: 'queued' }),
    ]);
    expect(f.requestDrain).toHaveBeenCalledWith(CHAT_ID, 'queued steer released');

    f.ownership.removeAttempt(CHAT_ID, f.attempt);
    f.ownership.installAttempt(
      CHAT_ID,
      new QueueExecutionAttempt({ turnId: 'turn-2', clientRequestId: 'request-2' }),
    );
    f.admitInput.mockImplementation(async () => true);
    await f.deliver();

    expect(f.admitInput).toHaveBeenCalledTimes(3);
    expect((await f.controls.read(CHAT_ID)).entries).toEqual([]);
  });

  it('consumes a steer that was recorded but not delivered', async () => {
    const f = scaffold({
      steerInput: mock(async (_chatId, _input, _options, _target, prepareDelivery) => {
        await prepareDelivery();
        return { kind: 'rejected', reason: 'turn-not-steerable', message: 'Not steerable' };
      }),
    });
    await f.addSteer('guidance for a review turn');
    await f.addSteer('later guidance');

    await f.deliver();

    expect(f.admitInput).toHaveBeenCalledTimes(2);
    const control = await f.controls.read(CHAT_ID);
    expect(control.entries).toEqual([]);
    expect(control.recentlyDispatched.map((entry) => entry.entryId)).toEqual(['steer-1', 'steer-2']);
  });

  it('runs again when a request arrives during a pass', async () => {
    const f = scaffold();
    f.state.providerTarget = null;
    const captured = deferred();
    const release = deferred();
    f.turnRunner.captureSteerTarget.mockImplementationOnce(async () => {
      captured.resolve();
      await release.promise;
      return null;
    });
    await f.addSteer('guidance');

    f.delivery.request(CHAT_ID);
    await captured.promise;
    f.state.providerTarget = {};
    f.delivery.request(CHAT_ID);
    release.resolve();
    while (f.tasks.length > 0) await f.tasks.shift();

    expect(f.admitInput).toHaveBeenCalledTimes(1);
    expect((await f.controls.read(CHAT_ID)).entries).toEqual([]);
  });

  it('runs a pass requested during a failed one', async () => {
    const resolving = deferred();
    const failing = deferred();
    let resolutions = 0;
    const f = scaffold({
      resolveContent: mock(async ({ content }) => {
        resolutions += 1;
        if (resolutions > 1) return content;
        resolving.resolve();
        await failing.promise;
        throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor is unavailable', 503, true);
      }),
    });
    await f.addSteer('guidance');

    f.delivery.request(CHAT_ID);
    await resolving.promise;
    f.delivery.request(CHAT_ID);
    failing.resolve();
    while (f.tasks.length > 0) await f.tasks.shift();

    expect(f.admitInput).toHaveBeenCalledTimes(1);
    expect((await f.controls.read(CHAT_ID)).entries).toEqual([]);
  });

  it('stops without delivering when target capture fails', async () => {
    const f = scaffold();
    f.turnRunner.captureSteerTarget.mockImplementation(async () => {
      throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor is unavailable', 503, true);
    });
    await f.addSteer('guidance');

    await f.deliver();

    expect(f.admitInput).not.toHaveBeenCalled();
    expect((await f.controls.read(CHAT_ID)).entries).toHaveLength(1);
  });
});
