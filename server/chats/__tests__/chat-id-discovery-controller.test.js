import { describe, expect, it, mock } from 'bun:test';
import { ChatIdDiscoveryController } from '../chat-id-discovery-controller.ts';
import { DomainError } from '../../lib/domain-error.ts';

const CHAT_ID = '1787836573296800';
const VIEW_ID = 'view-1';
const AT = '2026-08-28T00:00:00.000Z';

function target(turnId = 'run-1') {
  return {
    attempt: {},
    identity: { turnId },
    providerTarget: { turnId },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ChatIdDiscoveryController', () => {
  it('starts a provider-only control steer immediately and records success after delivery', async () => {
    const delivery = deferred();
    const deliverControlSteer = mock(() => delivery.promise);
    const appendNotice = mock(() => undefined);
    const controller = new ChatIdDiscoveryController({
      execution: {
        captureSteerTarget: mock(() => target()),
        deliverControlSteer,
      },
      notices: { appendNotice },
    });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });

    expect(deliverControlSteer).toHaveBeenCalledWith(
      CHAT_ID,
      '<garcon-chat-id>1787836573296800</garcon-chat-id>',
      VIEW_ID,
      target(),
    );
    expect(appendNotice).not.toHaveBeenCalled();

    delivery.resolve();
    await delivery.promise;
    await Promise.resolve();
    expect(appendNotice).toHaveBeenCalledWith(CHAT_ID, VIEW_ID, {
      title: 'Response: Garcon Chat ID',
      content: 'Sent chat ID 1787836573296800 to agent',
      detail: { type: 'chat-id-disclosure' },
      at: AT,
    });
  });

  it('dispatches at most once for each chat run', () => {
    let activeRun = 'run-1';
    const deliverControlSteer = mock(() => new Promise(() => undefined));
    const controller = new ChatIdDiscoveryController({
      execution: {
        captureSteerTarget: mock(() => target(activeRun)),
        deliverControlSteer,
      },
      notices: { appendNotice: mock(() => undefined) },
    });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });
    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });
    activeRun = 'run-2';
    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-2', at: AT });

    expect(deliverControlSteer).toHaveBeenCalledTimes(2);
  });

  it('records unsupported steering as a typed failure', async () => {
    const appendNotice = mock(() => undefined);
    const error = new DomainError(
      'OPERATION_UNSUPPORTED',
      'This agent does not support steering',
      422,
    );
    const controller = new ChatIdDiscoveryController({
      execution: {
        captureSteerTarget: mock(() => target()),
        deliverControlSteer: mock(async () => { throw error; }),
      },
      notices: { appendNotice },
    });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });
    await Promise.resolve();

    expect(appendNotice).toHaveBeenCalledWith(CHAT_ID, VIEW_ID, {
      title: 'Response: Garcon Chat ID',
      content: 'This agent does not support chat ID auto-discovery steering.',
      detail: { type: 'chat-id-discovery-failure', reason: 'unsupported' },
    });
  });

  it('records one failure for repeated requests without an active run', () => {
    const appendNotice = mock(() => undefined);
    const deliverControlSteer = mock(async () => undefined);
    const captureSteerTarget = mock(() => null);
    const controller = new ChatIdDiscoveryController({
      execution: {
        captureSteerTarget,
        deliverControlSteer,
      },
      notices: { appendNotice },
    });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: null, at: AT });
    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: null, at: AT });

    expect(deliverControlSteer).not.toHaveBeenCalled();
    expect(captureSteerTarget).not.toHaveBeenCalled();
    expect(appendNotice).toHaveBeenCalledTimes(1);
    expect(appendNotice).toHaveBeenCalledWith(CHAT_ID, VIEW_ID, {
      title: 'Response: Garcon Chat ID',
      content: 'The active turn ended before Garcon could send the chat ID.',
      detail: { type: 'chat-id-discovery-failure', reason: 'turn-unavailable' },
    });
  });

  it('does not record a delivery outcome after the chat is discarded', async () => {
    const delivery = deferred();
    const appendNotice = mock(() => undefined);
    const controller = new ChatIdDiscoveryController({
      execution: {
        captureSteerTarget: mock(() => target()),
        deliverControlSteer: mock(() => delivery.promise),
      },
      notices: { appendNotice },
    });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });
    controller.discard(CHAT_ID);
    delivery.resolve();
    await delivery.promise;
    await Promise.resolve();

    expect(appendNotice).not.toHaveBeenCalled();
  });
});
