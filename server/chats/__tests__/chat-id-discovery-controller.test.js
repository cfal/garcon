import { describe, expect, it, mock } from 'bun:test';
import { ChatIdDiscoveryController } from '../chat-id-discovery-controller.ts';
import { DomainError } from '../../lib/domain-error.ts';

const CHAT_ID = '1787836573296800';
const VIEW_ID = 'view-1';
const AT = '2026-08-28T00:00:00.000Z';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createController(overrides = {}) {
  const appendNotice = mock(() => undefined);
  const deliverControlInput = mock(async () => undefined);
  const options = {
    execution: { deliverControlInput },
    notices: { appendNotice },
    isEnabled: () => true,
    ...overrides,
  };
  const controller = new ChatIdDiscoveryController(options);
  return {
    appendNotice,
    controller,
    deliverControlInput: options.execution.deliverControlInput,
  };
}

describe('ChatIdDiscoveryController', () => {
  it('records one success notice as soon as delivery is accepted', async () => {
    const delivery = deferred();
    const deliverControlInput = mock(() => delivery.promise);
    const { appendNotice, controller } = createController({
      execution: { deliverControlInput },
    });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });

    expect(deliverControlInput).toHaveBeenCalledWith(
      CHAT_ID,
      '<garcon-chat-id>1787836573296800</garcon-chat-id>',
      VIEW_ID,
      'run-1',
      expect.anything(),
      expect.any(Function),
    );
    expect(appendNotice).not.toHaveBeenCalled();

    delivery.resolve();
    await delivery.promise;
    await Promise.resolve();
    expect(appendNotice).toHaveBeenCalledWith(CHAT_ID, VIEW_ID, {
      title: 'Chat ID auto-discovery',
      content: 'Sent chat ID 1787836573296800 to agent.',
      detail: { type: 'chat-id-disclosure' },
      at: AT,
    });
  });

  it('[TLV5-CHAT-ID-DISCOVERY.06-CORE-UNIT-01] records one disabled notice without attempting delivery', () => {
    const { appendNotice, controller, deliverControlInput } = createController({
      isEnabled: () => false,
    });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });

    expect(deliverControlInput).not.toHaveBeenCalled();
    expect(appendNotice).toHaveBeenCalledWith(CHAT_ID, VIEW_ID, {
      title: 'Chat ID auto-discovery',
      content: 'Chat ID auto-discovery is disabled.',
      detail: { type: 'chat-id-discovery-failure', reason: 'disabled' },
      at: AT,
    });
  });

  it('serializes overlapping requests per chat', async () => {
    const delivery = deferred();
    const deliverControlInput = mock(() => delivery.promise);
    const { appendNotice, controller } = createController({ execution: { deliverControlInput } });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });
    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });
    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-2', at: AT });

    expect(deliverControlInput).toHaveBeenCalledTimes(1);
    expect(appendNotice).not.toHaveBeenCalled();

    delivery.resolve();
    await delivery.promise;
    await Promise.resolve();
    expect(appendNotice).toHaveBeenCalledTimes(1);
  });

  it('delivers sequential requests from the same run after each attempt settles', async () => {
    const deliverControlInput = mock(async () => undefined);
    const { appendNotice, controller } = createController({ execution: { deliverControlInput } });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });
    await Promise.resolve();
    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });
    await Promise.resolve();

    expect(deliverControlInput).toHaveBeenCalledTimes(2);
    expect(appendNotice).toHaveBeenCalledTimes(2);
  });

  it('treats independent no-run markers as separate requests', async () => {
    const deliverControlInput = mock(async () => undefined);
    const { controller } = createController({ execution: { deliverControlInput } });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: null, at: AT });
    await Promise.resolve();
    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: null, at: AT });
    await Promise.resolve();

    expect(deliverControlInput).toHaveBeenCalledTimes(2);
  });

  it('[TLV5-CHAT-ID-DISCOVERY.04-CORE-RECURSION-UNIT-01] suppresses uncorrelated markers after its control turn', async () => {
    const deliverControlInput = mock(async (
      _chatId,
      _content,
      _viewId,
      _runId,
      _signal,
      onControlRun,
    ) => {
      onControlRun('control-turn');
    });
    const { controller } = createController({ execution: { deliverControlInput } });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });
    await Promise.resolve();
    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'control-turn', at: AT });
    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: null, at: AT });
    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-2', at: AT });
    await Promise.resolve();

    expect(deliverControlInput).toHaveBeenCalledTimes(2);
  });

  it('maps an unexpected unsupported rejection to the generic failure', async () => {
    const error = new DomainError(
      'OPERATION_UNSUPPORTED',
      'This agent does not support steering',
      422,
    );
    const { appendNotice, controller } = createController({
      execution: {
        deliverControlInput: mock(async () => { throw error; }),
      },
    });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });
    await Promise.resolve();

    expect(appendNotice).toHaveBeenCalledWith(CHAT_ID, VIEW_ID, {
      title: 'Chat ID auto-discovery',
      content: 'Garcon could not send the chat ID to the agent.',
      detail: { type: 'chat-id-discovery-failure', reason: 'delivery-failed' },
      at: AT,
    });
  });

  it('records a generic failure when no route accepts the input', async () => {
    const { appendNotice, controller } = createController({
      execution: {
        deliverControlInput: mock(async () => {
          throw new DomainError('SESSION_BUSY', 'No route', 409);
        }),
      },
    });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });
    await Promise.resolve();

    expect(appendNotice).toHaveBeenCalledWith(CHAT_ID, VIEW_ID, {
      title: 'Chat ID auto-discovery',
      content: 'Garcon could not send the chat ID to the agent.',
      detail: { type: 'chat-id-discovery-failure', reason: 'delivery-failed' },
      at: AT,
    });
  });

  it('records a generic failure when delivery throws synchronously', () => {
    const error = new Error('Execution queue is not initialized');
    const onError = mock(() => undefined);
    const { appendNotice, controller } = createController({
      execution: {
        deliverControlInput: mock(() => { throw error; }),
      },
      onError,
    });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });

    expect(onError).toHaveBeenCalledWith(error, CHAT_ID);
    expect(appendNotice).toHaveBeenCalledWith(CHAT_ID, VIEW_ID, {
      title: 'Chat ID auto-discovery',
      content: 'Garcon could not send the chat ID to the agent.',
      detail: { type: 'chat-id-discovery-failure', reason: 'delivery-failed' },
      at: AT,
    });
  });

  it('records an unknown delivery outcome as the generic failure', async () => {
    const { appendNotice, controller } = createController({
      execution: {
        deliverControlInput: mock(async () => {
          throw new DomainError(
            'STEER_OUTCOME_UNKNOWN',
            'The provider may have accepted the input',
            409,
          );
        }),
      },
    });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });
    await Promise.resolve();

    expect(appendNotice).toHaveBeenCalledWith(CHAT_ID, VIEW_ID, {
      title: 'Chat ID auto-discovery',
      content: 'Garcon could not send the chat ID to the agent.',
      detail: { type: 'chat-id-discovery-failure', reason: 'delivery-failed' },
      at: AT,
    });
  });

  it('does not record a delivery outcome after the chat is discarded', async () => {
    const delivery = deferred();
    let signal;
    const { appendNotice, controller } = createController({
      execution: {
        deliverControlInput: mock((_chatId, _content, _viewId, _runId, inputSignal) => {
          signal = inputSignal;
          return delivery.promise;
        }),
      },
    });

    controller.request({ chatId: CHAT_ID, viewId: VIEW_ID, runId: 'run-1', at: AT });
    controller.discard(CHAT_ID);
    expect(signal.aborted).toBe(true);
    delivery.resolve();
    await delivery.promise;
    await Promise.resolve();

    expect(appendNotice).not.toHaveBeenCalled();
  });
});
