import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SearchWorkerSupervisor } from '../worker-supervisor.js';

class ManualClock {
  now = 0;
  #nextId = 0;
  #timers = new Map();

  setTimeout = (callback, delay) => {
    const timer = { id: ++this.#nextId, at: this.now + delay, callback, unref() {} };
    this.#timers.set(timer.id, timer);
    return timer;
  };

  clearTimeout = (timer) => {
    this.#timers.delete(timer.id);
  };

  advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.#timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!next) break;
      this.#timers.delete(next.id);
      this.now = next.at;
      next.callback();
    }
    this.now = target;
  }
}

class ControlledWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  requests = [];
  terminateCount = 0;
  closeOnQuiesce = false;
  beforePostReturns = null;
  #listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? [];
    this.#listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  postMessage(request) {
    this.requests.push(request);
    if (request.type === 'open') this.emit({ type: 'opened', ...identity(request) });
    if (request.type === 'quiesce') {
      this.emit({ type: 'quiesced', ...identity(request) });
      if (this.closeOnQuiesce) this.close();
    }
    this.beforePostReturns?.(request);
  }

  emit(event) {
    this.onmessage?.({ data: event });
  }

  close() {
    for (const listener of this.#listeners.get('close') ?? []) listener({});
  }

  terminate() {
    this.terminateCount += 1;
  }
}

function identity(request) {
  return { requestId: request.requestId, lifecycleEpoch: request.lifecycleEpoch };
}

function harness() {
  const clock = new ManualClock();
  const workers = [];
  const faults = [];
  const supervisor = new SearchWorkerSupervisor({
    role: 'indexer',
    moduleUrl: 'synthetic-indexer',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    workerFactory: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
    createRequest: (input, envelope) => ({ ...input, ...envelope }),
    isEvent: (value) => value !== null && typeof value === 'object'
      && typeof value.type === 'string'
      && typeof value.lifecycleEpoch === 'string',
    eventError: (event) => event.type === 'error' ? new Error(event.code) : null,
    onEvent() {},
    onFault: (error) => faults.push(error.message),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, faults, supervisor, workers };
}

async function start(test) {
  await test.supervisor.start(new AbortController().signal, async (signal) => {
    const event = await test.supervisor.request([{ type: 'open' }], signal, 30_000);
    if (event.type !== 'opened') throw new Error('Synthetic admission failed');
  });
}

function phased() {
  return {
    startTimeoutMs: 30_000,
    physicalTimeoutMs: 30_000,
    isStarted: (event) => event.type === 'step-started',
    isComplete: (event) => event.type === 'physical-step-complete',
  };
}

describe('SearchWorkerSupervisor', () => {
  test('[TLV5-SEARCH.08-WATCHDOG-SERVICE-UNIT-01] moves the watchdog from post-return start timing to physical timing on step-started', async () => {
    const test = harness();
    await start(test);
    const worker = test.workers[0];
    const completion = test.supervisor.request([{ type: 'grant' }], undefined, phased());
    const grant = worker.requests.at(-1);

    test.clock.advance(29_999);
    expect(test.faults).toEqual([]);
    worker.emit({ type: 'step-started', ...identity(grant) });
    test.clock.advance(29_999);
    expect(test.faults).toEqual([]);
    worker.emit({ type: 'physical-step-complete', ...identity(grant) });

    await expect(completion).resolves.toMatchObject({ type: 'physical-step-complete' });
    expect(test.supervisor.available).toBe(true);
  });

  test('does not charge synchronous postMessage time to the step-start watchdog', async () => {
    const test = harness();
    await start(test);
    const worker = test.workers[0];
    worker.beforePostReturns = (request) => {
      if (request.type === 'grant') test.clock.advance(30_000);
    };
    const completion = test.supervisor.request([{ type: 'grant' }], undefined, phased());
    const grant = worker.requests.at(-1);

    expect(test.faults).toEqual([]);
    worker.emit({ type: 'step-started', ...identity(grant) });
    worker.emit({ type: 'physical-step-complete', ...identity(grant) });

    await expect(completion).resolves.toMatchObject({ type: 'physical-step-complete' });
  });

  test('fences on a missing step-started without terminating or overlapping a replacement', async () => {
    const test = harness();
    await start(test);
    const first = test.workers[0];
    const completion = test.supervisor.request([{ type: 'grant' }], undefined, phased());

    test.clock.advance(30_000);

    await expect(completion).rejects.toThrow('WORKER_STEP_START_TIMEOUT');
    expect(test.faults).toEqual(['WORKER_STEP_START_TIMEOUT']);
    expect(test.supervisor.available).toBe(false);
    expect(first.terminateCount).toBe(0);
    await expect(start(test)).rejects.toThrow('already started');

    const retiring = test.supervisor.cooperativeClose([{ type: 'quiesce' }], 30_000);
    await Promise.resolve();
    expect(test.workers).toHaveLength(1);
    first.close();
    await retiring;
    await start(test);

    expect(test.workers).toHaveLength(2);
    expect(first.terminateCount).toBe(0);
  });

  test('fences a started step at the independent physical deadline', async () => {
    const test = harness();
    await start(test);
    const worker = test.workers[0];
    const completion = test.supervisor.request([{ type: 'grant' }], undefined, phased());
    const grant = worker.requests.at(-1);
    worker.emit({ type: 'step-started', ...identity(grant) });

    test.clock.advance(30_000);

    await expect(completion).rejects.toThrow('WORKER_PHYSICAL_STEP_TIMEOUT');
    expect(test.faults).toEqual(['WORKER_PHYSICAL_STEP_TIMEOUT']);
    expect(worker.terminateCount).toBe(0);
  });

  test('requires both the cooperative acknowledgement and actual close event', async () => {
    const test = harness();
    await start(test);
    const worker = test.workers[0];
    let settled = false;
    const retiring = test.supervisor.cooperativeClose([{ type: 'quiesce' }], 30_000)
      .then(() => { settled = true; });

    await Promise.resolve();
    expect(worker.requests.at(-1).type).toBe('quiesce');
    expect(settled).toBe(false);
    expect(test.supervisor.available).toBe(false);
    worker.close();
    await retiring;

    expect(settled).toBe(true);
    expect(worker.terminateCount).toBe(0);
  });

  test('observes a real Bun Worker exit through the EventTarget close event', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'search-worker-close-'));
    const workerPath = path.join(directory, 'worker.mjs');
    await writeFile(workerPath, `
self.onmessage = ({ data }) => {
  if (data.type === 'open') {
    self.postMessage({ type: 'opened', requestId: data.requestId, lifecycleEpoch: data.lifecycleEpoch });
    return;
  }
  if (data.type === 'quiesce') {
    self.postMessage({ type: 'quiesced', requestId: data.requestId, lifecycleEpoch: data.lifecycleEpoch });
    process.exit(0);
  }
};
`);
    const supervisor = new SearchWorkerSupervisor({
      role: 'indexer',
      moduleUrl: workerPath,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      createRequest: (input, envelope) => ({ ...input, ...envelope }),
      isEvent: (value) => value !== null && typeof value === 'object'
        && typeof value.type === 'string'
        && typeof value.lifecycleEpoch === 'string',
      eventError: () => null,
      onEvent() {},
    });
    try {
      await supervisor.start(new AbortController().signal, async (signal) => {
        const event = await supervisor.request([{ type: 'open' }], signal, 5_000);
        if (event.type !== 'opened') throw new Error('Synthetic admission failed');
      });

      await expect(supervisor.cooperativeClose([{ type: 'quiesce' }], 5_000))
        .resolves.toBeUndefined();
      expect(supervisor.available).toBe(false);
    } finally {
      await supervisor.stop([{ type: 'quiesce' }], 100);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
