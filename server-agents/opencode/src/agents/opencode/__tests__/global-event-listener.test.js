import { expect, it, mock } from 'bun:test';
import { OpenCodeGlobalEventListener } from '../global-event-listener.js';

function createEventStream() {
  const events = [];
  const waiters = [];
  let closed = false;

  return {
    push(event) {
      events.push(event);
      for (const resolve of waiters.splice(0)) resolve();
    },
    close() {
      closed = true;
      for (const resolve of waiters.splice(0)) resolve();
    },
    async *stream() {
      while (!closed || events.length > 0) {
        const event = events.shift();
        if (event) {
          yield event;
          continue;
        }
        await new Promise((resolve) => waiters.push(resolve));
      }
    },
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
}

it('waits for provider event delivery confirmation after server.connected', async () => {
  const eventStream = createEventStream();
  const client = {
    global: {
      event: mock(() => Promise.resolve({ stream: eventStream.stream() })),
    },
  };
  const confirmEventDelivery = mock(async ({ waitForEvent }) => {
    await waitForEvent((event) =>
      event.type === 'tui.toast.show'
      && event.properties?.message === 'readiness-confirmed'
    );
  });
  const listener = new OpenCodeGlobalEventListener({
    requestTimeoutMs: 1_000,
    heartbeatTimeoutMs: 1_000,
    retryDelayMs: 1_000,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getClient: () => Promise.resolve(client),
    isShuttingDown: () => false,
    isTemporarilyUnavailable: () => false,
    getUnavailableRetryAfterMs: () => 0,
    markTemporarilyUnavailable: () => false,
    failRunningTurns: mock(() => undefined),
    closeUnavailableInstanceIfIdle: () => false,
    confirmEventDelivery,
    handleEvent: mock(() => undefined),
  });
  let ready = false;
  const starting = listener.start('/repo').then(() => {
    ready = true;
  });

  eventStream.push({
    payload: { id: 'evt_connected', type: 'server.connected', properties: {} },
  });
  await waitFor(() => confirmEventDelivery.mock.calls.length === 1);
  expect(ready).toBe(false);
  expect(confirmEventDelivery.mock.calls[0][0].directory).toBe('/repo');

  eventStream.push({
    payload: {
      id: 'evt_confirmed',
      type: 'tui.toast.show',
      properties: { message: 'readiness-confirmed' },
    },
  });
  await starting;
  expect(ready).toBe(true);

  const abortController = new AbortController();
  const cancelled = listener.waitForEvent(
    (event) => event.type === 'test.barrier',
    abortController.signal,
  );
  const survivor = listener.waitForEvent((event) => event.type === 'test.barrier');
  abortController.abort(new Error('barrier cancelled'));
  await expect(cancelled).rejects.toThrow('barrier cancelled');
  eventStream.push({
    payload: { id: 'evt_barrier', type: 'test.barrier', properties: {} },
  });
  await expect(survivor).resolves.toMatchObject({ type: 'test.barrier' });

  listener.close();
  eventStream.close();
});
