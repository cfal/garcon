import { describe, expect, test } from 'bun:test';
import { SearchWorkerSupervisor } from '../worker-supervisor.js';

function stubWorkerFactory(behavior, options = {}) {
  return () => {
    const listeners = new Map();
    const deliver = (reply) => listeners.get('message')?.({ data: reply });
    options.exposeMessageDelivery?.(deliver);
    return {
      addEventListener: (name, handler) => listeners.set(name, handler),
      set onmessage(handler) { listeners.set('message', handler); },
      set onerror(handler) { listeners.set('error', handler); },
      set onmessageerror(handler) { listeners.set('messageerror', handler); },
      postMessage: (message) => behavior(message, deliver),
      terminate: () => {
        if (!options.swallowClose) listeners.get('close')?.();
      },
    };
  };
}

function createSupervisor(overrides = {}) {
  return new SearchWorkerSupervisor({
    role: 'reader',
    moduleUrl: 'stub',
    logger: { warn: () => {} },
    workerFactory: stubWorkerFactory(() => {}),
    createRequest: (input, envelope) => ({ ...input, ...envelope }),
    isEvent: (value) => typeof value === 'object' && value !== null,
    eventError: () => null,
    shouldRestart: () => false,
    admit: async () => {},
    onEvent: () => {},
    onCrash: () => {},
    ...overrides,
  });
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('condition not reached');
    await Bun.sleep(10);
  }
}

describe('worker supervisor v9', () => {
  test('[TLV5-SEARCH.08-SUP-01] abort does not retire or restart', async () => {
    let restartChecks = 0;
    const supervisor = createSupervisor({
      shouldRestart: () => {
        restartChecks += 1;
        return false;
      },
    });
    await supervisor.start(new AbortController().signal);
    const abort = new AbortController();
    const pending = supervisor.request([{ type: 'silent' }], abort.signal, 5_000);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(supervisor.available).toBe(true);
    expect(restartChecks).toBe(0);
  });

  test('[TLV5-SEARCH.08-SUP-02] grace exhaustion retires before rejection', async () => {
    let crashes = 0;
    const supervisor = createSupervisor({
      workerFactory: stubWorkerFactory((message, reply) => {
        if (message.type === 'answered') {
          reply({
            type: 'ok',
            requestId: message.requestId,
            lifecycleEpoch: message.lifecycleEpoch,
          });
        }
      }),
      onCrash: () => { crashes += 1; },
    });
    await supervisor.start(new AbortController().signal);
    await supervisor.request([{ type: 'answered' }], undefined, 1_000);
    let availableAtRejection = true;
    await supervisor.request([{ type: 'silent' }], undefined, 10).catch((error) => {
      availableAtRejection = supervisor.available;
      expect(error.message).toBe('SEARCH_TIMEOUT');
    });
    expect(availableAtRejection).toBe(false);
    expect(crashes).toBe(1);
  });

  test('[TLV5-SEARCH.08-SUP-03] replacement waits for the actual close event', async () => {
    let constructions = 0;
    let closeListener = null;
    const supervisor = createSupervisor({
      workerFactory: () => {
        constructions += 1;
        const listeners = new Map();
        return {
          addEventListener: (name, handler) => {
            listeners.set(name, handler);
            if (name === 'close') closeListener = handler;
          },
          set onmessage(handler) { listeners.set('message', handler); },
          set onerror(handler) { listeners.set('error', handler); },
          set onmessageerror(handler) { listeners.set('messageerror', handler); },
          postMessage: () => {},
          terminate: () => {},
        };
      },
      shouldRestart: () => true,
    });
    await supervisor.start(new AbortController().signal);
    await supervisor.request([{ type: 'silent' }], undefined, 10).catch(() => undefined);
    await Bun.sleep(100);
    expect(constructions).toBe(1);
    expect(supervisor.available).toBe(false);
    closeListener?.();
    await waitFor(() => constructions === 2, 2_000);
    expect(supervisor.available).toBe(true);
  });

  test('[TLV5-SEARCH.07-SUP-01] progress events re-arm the deadline', async () => {
    const supervisor = createSupervisor({
      role: 'indexer',
      isProgress: (event) => event.type === 'delete-progress',
      workerFactory: stubWorkerFactory((message, reply) => {
        if (message.type !== 'delete-chat') return;
        const beat = (round) => {
          if (round === 4) {
            reply({
              type: 'ack',
              requestId: message.requestId,
              lifecycleEpoch: message.lifecycleEpoch,
            });
            return;
          }
          reply({
            type: 'delete-progress',
            requestId: message.requestId,
            lifecycleEpoch: message.lifecycleEpoch,
            deletedRows: 1,
          });
          setTimeout(() => beat(round + 1), 30);
        };
        beat(0);
      }),
      onCrash: () => { throw new Error('must not retire'); },
    });
    await supervisor.start(new AbortController().signal);
    const event = await supervisor.request(
      [{ type: 'delete-chat', chatId: 'chat-0001' }],
      undefined,
      50,
    );
    expect(event.type).toBe('ack');
  });

  test('[TLV5-SEARCH.07-SUP-02] sessions retain identity across matched phases', async () => {
    const requestIds = [];
    const supervisor = createSupervisor({
      role: 'indexer',
      workerFactory: stubWorkerFactory((message, reply) => {
        requestIds.push(message.requestId);
        reply({
          type: `${message.type}-complete`,
          requestId: message.requestId,
          lifecycleEpoch: message.lifecycleEpoch,
        });
      }),
    });
    await supervisor.start(new AbortController().signal);
    const session = supervisor.beginRequestSession();
    const first = await session.request([{ type: 'first' }], undefined, 1_000, {
      isComplete: (event) => event.type === 'first-complete',
    });
    const second = await session.request([{ type: 'second' }], undefined, 1_000, {
      isComplete: (event) => event.type === 'second-complete',
    });
    expect(first.type).toBe('first-complete');
    expect(second.type).toBe('second-complete');
    expect(requestIds).toEqual([session.requestId, session.requestId]);
  });

  test('[TLV5-SEARCH.08-SUP-04] cooperative stop observes acknowledgement and close', async () => {
    let closeListener = null;
    const supervisor = createSupervisor({
      workerFactory: () => {
        const listeners = new Map();
        return {
          addEventListener: (name, handler) => {
            listeners.set(name, handler);
            if (name === 'close') closeListener = handler;
          },
          set onmessage(handler) { listeners.set('message', handler); },
          set onerror(handler) { listeners.set('error', handler); },
          set onmessageerror(handler) { listeners.set('messageerror', handler); },
          postMessage: (message) => {
            if (message.type !== 'close') return;
            listeners.get('message')?.({
              data: {
                type: 'closed',
                requestId: message.requestId,
                lifecycleEpoch: message.lifecycleEpoch,
              },
            });
            closeListener?.();
          },
          terminate: () => closeListener?.(),
        };
      },
    });
    await supervisor.start(new AbortController().signal);
    await supervisor.stop({ type: 'close' }, 1_000);
    expect(supervisor.available).toBe(false);
  });

  test('[TLV5-SEARCH.08-SUP-05] an invalid idle message retires the worker', async () => {
    let deliver;
    let crashes = 0;
    const supervisor = createSupervisor({
      workerFactory: stubWorkerFactory(() => {}, {
        exposeMessageDelivery: (value) => { deliver = value; },
      }),
      isEvent: (value) => value?.type === 'ok',
      onCrash: () => { crashes += 1; },
    });
    await supervisor.start(new AbortController().signal);

    deliver({ invalid: true });

    expect(supervisor.available).toBe(false);
    expect(crashes).toBe(1);
  });
});
