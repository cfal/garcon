import { expect, test } from 'bun:test';
import { DisplayWorkerClient, type DisplayWorkerHandle } from '../worker-client.js';
import type { DisplayWorkerReply, DisplayWorkerRequest } from '../worker-protocol.js';

class FakeWorker implements DisplayWorkerHandle {
  onmessage: DisplayWorkerHandle['onmessage'] = null;
  onerror: DisplayWorkerHandle['onerror'] = null;
  onmessageerror: DisplayWorkerHandle['onmessageerror'] = null;
  readonly messages: DisplayWorkerRequest[] = [];
  readonly listeners: (() => void)[] = [];
  terminated = false;
  postMessage(message: DisplayWorkerRequest): void { this.messages.push(message); }
  addEventListener(_type: 'close', listener: () => void): void { this.listeners.push(listener); }
  terminate(): void { this.terminated = true; }
  close(): void { for (const listener of this.listeners) listener(); }
  reply(result: DisplayWorkerReply): void { this.onmessage?.({ data: result } as MessageEvent<DisplayWorkerReply>); }
}

test('caller cancellation retains the writer slot until acknowledgement', async () => {
  const worker = new FakeWorker(), client = new DisplayWorkerClient('builder', { createWorker: () => worker });
  const abort = new AbortController();
  const first = client.request({ kind: 'close', path: 'first' }, abort.signal).catch(error => error);
  const second = client.request({ kind: 'close', path: 'second' });
  abort.abort(new Error('cancelled'));
  expect(await first).toBeInstanceOf(Error);
  expect(worker.messages).toHaveLength(1);
  worker.reply({ id: 1, ok: true, result: null });
  expect(worker.messages).toHaveLength(2);
  worker.reply({ id: 2, ok: true, result: null });
  expect(await second).toBeNull();
  const closing = client.close(); worker.close(); await closing;
});

test('timeout never starts a replacement while the previous writer could still be alive', async () => {
  const workers: FakeWorker[] = [];
  const client = new DisplayWorkerClient('builder', { retirementTimeoutMs: 20,
    createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  const expired = client.request({ kind: 'close', path: 'first' }, undefined, 5).catch(error => error);
  const queued = client.request({ kind: 'close', path: 'second' }).catch(error => error);
  expect(await expired).toMatchObject({ code: 'DISPLAY_UNAVAILABLE' });
  expect(await queued).toMatchObject({ code: 'DISPLAY_UNAVAILABLE' });
  expect(workers).toHaveLength(1);
  expect(workers[0].terminated).toBe(true);
  await expect(client.request({ kind: 'close', path: 'third' })).rejects.toMatchObject({ code: 'DISPLAY_UNAVAILABLE' });
  workers[0].close();
  const next = client.request({ kind: 'close', path: 'fourth' });
  expect(workers).toHaveLength(2);
  workers[1].reply({ id: workers[1].messages[0].id, ok: true, result: null });
  expect(await next).toBeNull();
  const closing = client.close(); workers[1].close(); await closing;
});

test('bounds admission and handles startup failure without stranded callers', async () => {
  const broken = new DisplayWorkerClient('reader', { createWorker: () => { throw new Error('unavailable'); } });
  await expect(broken.request({ kind: 'close', path: 'first' })).rejects.toMatchObject({ code: 'DISPLAY_UNAVAILABLE' });
  await broken.close();
  const worker = new FakeWorker(), client = new DisplayWorkerClient('reader', { createWorker: () => worker });
  const requests = Array.from({ length: 33 }, () => client.request({ kind: 'close', path: 'first' }).catch(error => error));
  await expect(client.request({ kind: 'close', path: 'overflow' })).rejects.toMatchObject({ code: 'DISPLAY_BUSY' });
  const closing = client.close(); worker.close(); await closing;
  expect((await Promise.all(requests)).every(result => result instanceof Error)).toBe(true);
});

test('a transient startup failure allows a later request to create a worker', async () => {
  const worker = new FakeWorker();
  let attempts = 0;
  const client = new DisplayWorkerClient('reader', { createWorker: () => {
    if (++attempts === 1) throw new Error('Temporary resource exhaustion');
    return worker;
  } });
  await expect(client.request({ kind: 'close', path: 'first' })).rejects.toMatchObject({ code: 'DISPLAY_UNAVAILABLE' });
  const retry = client.request({ kind: 'close', path: 'second' });
  expect(attempts).toBe(2);
  worker.reply({ id: worker.messages[0].id, ok: true, result: null });
  expect(await retry).toBeNull();
  const closing = client.close(); worker.close(); await closing;
});
