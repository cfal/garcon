import { expect, mock, test } from 'bun:test';
import { NodeWorkerLifeline, NODE_WORKER_INERT_TIMEOUT_MS, NODE_WORKER_PULSE_TIMEOUT_MS } from '../lifeline.js';
import { NodeWorkerAuthority } from '../authority.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };

function fixture() {
  let elapsedMs = 0;
  let discontinuity = false;
  const timers: { callback(): void; cancelled: boolean }[] = [];
  const retired = mock(() => {});
  const lifeline = new NodeWorkerLifeline({ clock: { read: () => ({ elapsedMs, discontinuity }) }, retired,
    scheduleTimeout(callback) { const timer = { callback, cancelled: false }; timers.push(timer); return { cancel() { timer.cancelled = true; } }; },
  });
  return { lifeline, timers, retired, advance(ms: number) { elapsedMs += ms; }, suspend() { discontinuity = true; } };
}

test('pulses cannot extend the absolute preconfiguration deadline or configure an expired inert worker', () => {
  const f = fixture();
  f.advance(NODE_WORKER_INERT_TIMEOUT_MS - 1); f.lifeline.pulse();
  expect(f.lifeline.signal.aborted).toBe(false);
  f.advance(1);
  expect(() => f.lifeline.configure()).toThrow('NODE_WORKER_TIMEOUT');
  expect(f.retired).toHaveBeenCalledTimes(1);
  expect(() => f.lifeline.pulse()).toThrow('NODE_WORKER_TIMEOUT');
});

test('configured workers need timely parent pulses even when their pipe is still open', () => {
  const f = fixture(); f.lifeline.configure();
  f.advance(NODE_WORKER_PULSE_TIMEOUT_MS - 1); f.lifeline.pulse();
  f.advance(NODE_WORKER_PULSE_TIMEOUT_MS - 1);
  expect(() => f.lifeline.poll()).not.toThrow();
  f.advance(1);
  f.timers.at(-1)!.callback();
  expect(f.lifeline.signal.aborted).toBe(true);
  expect(f.retired).toHaveBeenCalledTimes(1);
});

test('an early timer rearms the remaining deadline instead of abandoning the watchdog', () => {
  const f = fixture(); f.lifeline.configure();
  f.advance(NODE_WORKER_PULSE_TIMEOUT_MS - 1);
  f.timers.at(-1)!.callback();
  expect(f.lifeline.signal.aborted).toBe(false);
  f.advance(1); f.timers.at(-1)!.callback();
  expect(f.lifeline.signal.aborted).toBe(true);
});

test('EOF and local clock discontinuity retire worker authority exactly once', () => {
  for (const cause of ['eof', 'suspend']) {
    const f = fixture(); f.lifeline.configure();
    if (cause === 'eof') f.lifeline.close();
    else { f.suspend(); expect(() => f.lifeline.poll()).toThrow(); }
    expect(f.lifeline.signal.aborted).toBe(true);
    expect(() => f.lifeline.configure()).toThrow();
    f.lifeline.close();
    expect(f.retired).toHaveBeenCalledTimes(1);
    expect(f.timers.every(({ cancelled }) => cancelled)).toBe(true);
  }
});

test('the worker mirrors physical gates without giving a reconnect new logical authority', () => {
  const f = fixture(); f.lifeline.configure();
  const authority = new NodeWorkerAuthority({ session, signal: f.lifeline.signal, poll: () => f.lifeline.poll() });
  const first = authority.attach(1);
  expect(() => authority.assertConnection(first)).not.toThrow();
  expect(() => authority.assertAdmission(first)).toThrow('suspended');
  authority.openAdmissions(1);
  expect(() => authority.assertAdmission(first)).not.toThrow();
  authority.disconnect(1);
  expect(first.signal.aborted).toBe(true);
  expect(first.authoritySignal.aborted).toBe(false);
  const next = authority.attach(2);
  authority.disconnect(1);
  expect(next.signal.aborted).toBe(false);
  expect(() => authority.openAdmissions(1)).toThrow();
  expect(() => authority.attach(1)).toThrow();
  expect(() => authority.assertConnection({ ...next })).toThrow();
  authority.openAdmissions(2);
  expect(() => authority.assertAdmission(first)).toThrow();
  expect(() => authority.assertAdmission(next)).not.toThrow();
  f.lifeline.close();
  expect(next.signal.aborted).toBe(true);
  expect(next.authoritySignal.aborted).toBe(true);
  expect(() => authority.attach(3)).toThrow();
});

test('an expired worker pulse fences buffered admission before its watchdog callback', () => {
  const f = fixture(); f.lifeline.configure();
  const authority = new NodeWorkerAuthority({ session, signal: f.lifeline.signal, poll: () => f.lifeline.poll() });
  const socket = authority.attach(1); authority.openAdmissions(1);
  f.advance(NODE_WORKER_PULSE_TIMEOUT_MS);
  expect(() => authority.assertAdmission(socket)).toThrow('retired');
  expect(socket.authoritySignal.aborted).toBe(true);
  expect(f.retired).toHaveBeenCalledTimes(1);
});
