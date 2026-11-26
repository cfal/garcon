import { expect, test } from 'bun:test';
import { createSessionFixture } from './thread-settings-fixture.js';

const startSession = createSessionFixture({ retainedSourceIdlePurge: { intervalMs: 5, maxIdleMs: 0 } });

async function fixture() {
  const f = await startSession('standard');
  f.first.finish();
  const cancellation = new AbortController();
  await f.runtime.runTurn({ ...f.resume, publicationSignal: cancellation.signal });
  const emit = (method: string, params: Record<string, unknown>) => f.first.client.emit('notification', { method, params });
  emit('item/completed', { threadId: 'thread-1', turnId: 'turn-2', item: {
    type: 'subAgentActivity', id: 'spawn-child', kind: 'started', agentThreadId: 'child-a', agentPath: '/root/child-a',
  } });
  const created = f.events.find(event => event.type === 'native-child-created');
  if (!created || created.type !== 'native-child-created') throw new Error('Missing observed child');
  return { ...f, emit, cancellation, child: created.child.ref };
}

test('actual notification ingress isolates malformed child content from parent settlement', async () => {
  const f = await fixture();
  f.emit('item/completed', { threadId: 'child-a', turnId: 'child-turn', item: null });
  f.first.finish();
  expect(f.events.filter(event => event.type === 'run-ended')).toMatchObject([{ outcome: 'finished' }, { outcome: 'finished' }]);
  expect(f.events.some(event => event.type === 'native-child-gap')).toBe(true);
  expect(f.events.some(event => event.type === 'native-child-detached')).toBe(true);
  expect(f.runtime.isRunning('thread-1')).toBe(false);
});

test('child activity retains the native writer and fences Reload after capture detaches', async () => {
  const f = await fixture();
  f.emit('turn/started', { threadId: 'child-a', turn: { id: 'child-turn', status: 'inProgress' } });
  f.first.finish();
  f.cancellation.abort();
  f.runtime.startPurgeTimer();
  await expect(f.runtime.loadChildHistory({ child: f.child, signal: new AbortController().signal }).next())
    .rejects.toMatchObject({ code: 'SESSION_BUSY' });
  expect(f.first.shutdown).not.toHaveBeenCalled();
  f.emit('turn/completed', { threadId: 'child-a', turn: { id: 'old-turn', status: 'completed', items: [] } });
  await expect(f.runtime.loadChildHistory({ child: f.child, signal: new AbortController().signal }).next())
    .rejects.toMatchObject({ code: 'SESSION_BUSY' });
});

test.each([true, false])('follow-up between child turns fences Reload (capture attached: %s)', async attached => {
  const f = await fixture();
  f.emit('turn/started', { threadId: 'child-a', turn: { id: 'child-turn', status: 'inProgress' } });
  f.emit('turn/completed', { threadId: 'child-a', turn: { id: 'child-turn', status: 'completed', items: [] } });
  if (!attached) f.cancellation.abort();
  f.emit('item/started', { threadId: 'thread-1', turnId: 'turn-2', item: {
    type: 'subAgentActivity', id: 'followup-child', kind: 'interacted', agentThreadId: 'child-a', agentPath: '/root/child-a',
  } });
  f.first.finish();
  await expect(f.runtime.loadChildHistory({ child: f.child, signal: new AbortController().signal }).next())
    .rejects.toMatchObject({ code: 'SESSION_BUSY' });
  f.emit('turn/started', { threadId: 'child-a', turn: { id: 'followup-turn', status: 'inProgress' } });
  f.emit('turn/completed', { threadId: 'child-a', turn: { id: 'followup-turn', status: 'completed', items: [] } });
  await expect(f.runtime.loadChildHistory({ child: f.child, signal: new AbortController().signal }).next())
    .rejects.toMatchObject({ code: 'SESSION_BUSY' });
  expect(f.first.shutdown).not.toHaveBeenCalled();
});

test('retiring clients remain busy after route removal until their native writer exit is confirmed', async () => {
  const f = await fixture();
  f.first.finish();
  const exited = Promise.withResolvers<number>();
  let confirmed = false;
  Object.defineProperties(f.first.client, {
    exited: { get: () => exited.promise },
    nativeWritersExited: { get: () => confirmed },
  });
  await f.runtime.releaseSession('chat-1', 'thread-1');
  await expect(f.runtime.loadChildHistory({ child: f.child, signal: new AbortController().signal }).next())
    .rejects.toMatchObject({ code: 'SESSION_BUSY' });
  exited.resolve(0);
  await exited.promise;
  await expect(f.runtime.loadChildHistory({ child: f.child, signal: new AbortController().signal }).next())
    .rejects.toMatchObject({ code: 'SESSION_BUSY' });
  confirmed = true;
  // The synthetic history client has no retained child. It must now reach the reader, not remain busy.
  await expect(f.runtime.loadChildHistory({ child: f.child, signal: new AbortController().signal }).next())
    .rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});

test('reaps a retired writer group on the existing purge tick without an exact-root Reload', async () => {
  const f = await fixture();
  f.first.finish();
  const exited = Promise.withResolvers<number>();
  const observed = Promise.withResolvers<void>();
  let confirmed = false;
  Object.defineProperties(f.first.client, {
    exited: { configurable: true, get: () => exited.promise },
    nativeWritersExited: { configurable: true, get: () => {
      if (confirmed) observed.resolve();
      return confirmed;
    } },
  });
  await f.runtime.releaseSession('chat-1', 'thread-1');
  exited.resolve(0);
  await exited.promise;
  confirmed = true;
  f.runtime.startPurgeTimer();
  await observed.promise;
  Object.defineProperty(f.first.client, 'nativeWritersExited', { get: () => { throw new Error('Retired client retained'); } });
  await expect(f.runtime.loadChildHistory({ child: f.child, signal: new AbortController().signal }).next())
    .rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});
