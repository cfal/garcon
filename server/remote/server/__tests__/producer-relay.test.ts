import { describe, expect, mock, test } from 'bun:test';
import type { AssistantMessage } from '@garcon/common/chat-types';
import {
  AgentCallError,
  AgentIntegrationError,
  createAgentResourceRef,
  type AgentIntegration,
  type AgentProducerNotification,
  type AgentResourceScope,
} from '@garcon/server-agent-interface';
import { ProducerRelay } from '../producer-relay.js';
import { EXECUTOR_DISCONNECTED_BEFORE_START } from '../../../common/executor-disconnect.js';

const SCOPE: AgentResourceScope = { executorId: 'executor-1', instanceId: 'instance-1', integrationId: 'test' };

function integrationDouble() {
  const listeners = new Set<(notification: AgentProducerNotification) => void>();
  const detach = mock((_binding: unknown) => undefined);
  const abort = mock(async (_handle: unknown) => true);
  const integration = {
    producers: {
      subscribe(listener: (notification: AgentProducerNotification) => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      detach,
    },
    execution: { abort },
  } as unknown as AgentIntegration;
  const binding = () => createAgentResourceRef(SCOPE, 'producer');
  const publish = (notification: AgentProducerNotification) => {
    for (const listener of listeners) listener(notification);
  };
  return { integration, binding, publish, detach, abort, listeners };
}

// Native admission that ends only when its signal aborts.
function pendingAdmission(signals: AbortSignal[]) {
  return (signal: AbortSignal) => new Promise<never>((_, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(new Error('Synthetic cancelled admission')), { once: true });
  });
}

function session(capacity = Infinity) {
  const sent: string[] = [];
  let limit = capacity;
  const frames = () => sent.map((payload) => JSON.parse(payload) as { seq: number; notification: AgentProducerNotification });
  return {
    sent,
    frames,
    offer: (payload: string) => {
      if (sent.length >= limit) return false;
      sent.push(payload);
      return true;
    },
    allow: (count: number) => { limit += count; },
    texts: () => frames().map(({ notification: { event } }) => (
      event.type === 'rows' ? (event.rows[0]!.message as AssistantMessage).content : event.type
    )),
  };
}

// Collects a launch's undelivered-reply listeners, which run when the test says
// the session could not take the reply.
function undeliveredReplies() {
  const listeners: (() => void)[] = [];
  return {
    observe: (listener: () => void) => { listeners.push(listener); },
    fire: () => { for (const listener of listeners.splice(0)) listener(); },
  };
}

function rows(text: string): AgentProducerNotification['event'] {
  return { type: 'rows', rows: [{ message: { type: 'assistant-message', timestamp: 'now', content: text } as never }] };
}

describe('ProducerRelay', () => {
  test('numbers frames per binding and replays only unacknowledged frames on resume', () => {
    const relay = new ProducerRelay();
    const { integration, binding, publish } = integrationDouble();
    relay.track(integration);
    const first = session();
    const ref = binding();
    relay.bind(first, integration, ref);

    for (const text of ['one', 'two', 'three']) publish({ binding: ref, event: rows(text) });
    relay.acknowledge(first, [{ bindingId: ref.id, seq: 2 }]);
    relay.suspend(first);
    const second = session();

    expect(relay.resume(second, integration, [{ binding: ref, acknowledgedSeq: 1 }]))
      .toEqual([{ bindingId: ref.id, replayThroughSeq: 3, launch: null, receivedRunIds: [] }]);
    expect(first.frames().map((frame) => frame.seq)).toEqual([1, 2, 3]);
    expect(second.frames().map((frame) => frame.seq)).toEqual([3]);
    publish({ binding: ref, event: rows('four') });
    expect(second.frames().map((frame) => frame.seq)).toEqual([3, 4]);
    relay.dispose();
  });

  test('retains output published while suspended and delivers it in order on resume', () => {
    const relay = new ProducerRelay();
    const { integration, binding, publish } = integrationDouble();
    relay.track(integration);
    const first = session();
    const ref = binding();
    relay.bind(first, integration, ref);
    relay.suspend(first);

    publish({ binding: ref, event: rows('during gap') });
    publish({ binding: ref, event: { type: 'run-ended', runId: 'run-1', outcome: 'finished' } });
    const second = session();
    relay.resume(second, integration, [{ binding: ref, acknowledgedSeq: 0 }]);

    expect(first.sent).toEqual([]);
    expect(second.frames().map((frame) => [frame.seq, frame.notification.event.type])).toEqual([
      [1, 'rows'],
      [2, 'run-ended'],
    ]);
    relay.dispose();
  });

  test('paces delivery to the session and keeps newer output behind the backlog', async () => {
    const relay = new ProducerRelay();
    const { integration, binding, publish } = integrationDouble();
    relay.track(integration);
    const first = session();
    const ref = binding();
    relay.bind(first, integration, ref);
    relay.suspend(first);
    for (const text of ['one', 'two', 'three', 'four']) publish({ binding: ref, event: rows(text) });
    const second = session(2);

    expect(relay.resume(second, integration, [{ binding: ref, acknowledgedSeq: 0 }]).map((state) => state.bindingId))
      .toEqual([ref.id]);
    publish({ binding: ref, event: rows('five') });
    relay.acknowledge(second, [{ bindingId: ref.id, seq: 1 }]);
    expect(second.texts()).toEqual(['one', 'two']);

    second.allow(3);
    await Bun.sleep(30);
    expect(second.texts()).toEqual(['one', 'two', 'three', 'four', 'five']);
    relay.dispose();
  });

  test('delivers frames from several bindings in publication order', () => {
    const relay = new ProducerRelay();
    const { integration, binding, publish } = integrationDouble();
    relay.track(integration);
    const first = session();
    const [left, right] = [binding(), binding()];
    relay.bind(first, integration, left);
    relay.bind(first, integration, right);
    relay.suspend(first);
    publish({ binding: left, event: rows('left one') });
    publish({ binding: right, event: rows('right one') });
    publish({ binding: left, event: rows('left two') });
    const second = session();

    relay.resume(second, integration, [
      { binding: right, acknowledgedSeq: 0 },
      { binding: left, acknowledgedSeq: 0 },
    ]);

    expect(second.texts()).toEqual(['left one', 'right one', 'left two']);
    relay.dispose();
  });

  test('keeps its place when the budget drops frames already handed to the session', async () => {
    const relay = new ProducerRelay({ retainedBytes: 2_048 });
    const { integration, binding, publish } = integrationDouble();
    relay.track(integration);
    const live = session(2);
    const ref = binding();
    relay.bind(live, integration, ref);

    for (const text of ['one', 'two', 'three']) publish({ binding: ref, event: rows(`${text}:${'x'.repeat(600)}`) });
    live.allow(5);
    await Bun.sleep(30);

    expect(live.frames().map((frame) => frame.seq)).toEqual([1, 2, 3]);
    relay.dispose();
  });

  test('drops the oldest row batches under pressure but keeps run facts', () => {
    const relay = new ProducerRelay({ retainedBytes: 2_048 });
    const { integration, binding, publish } = integrationDouble();
    relay.track(integration);
    const first = session();
    const ref = binding();
    relay.bind(first, integration, ref);
    relay.suspend(first);

    publish({ binding: ref, event: { type: 'started', runId: 'run-1' } });
    for (let index = 0; index < 6; index += 1) publish({ binding: ref, event: rows('x'.repeat(600)) });
    publish({ binding: ref, event: { type: 'run-ended', runId: 'run-1', outcome: 'finished' } });
    const second = session();
    relay.resume(second, integration, [{ binding: ref, acknowledgedSeq: 0 }]);

    const replayed = second.frames().map((frame) => [frame.seq, frame.notification.event.type]);
    expect(replayed[0]).toEqual([1, 'started']);
    expect(replayed.at(-1)).toEqual([8, 'run-ended']);
    expect(replayed.length).toBeLessThan(8);
    expect(second.sent.reduce((total, payload) => total + Buffer.byteLength(payload), 0)).toBeLessThan(3_000);
    relay.dispose();
  });

  test('ends the replay at the last retained frame when pressure dropped the tail', () => {
    const relay = new ProducerRelay({ retainedBytes: 2_048 });
    const { integration, binding, publish } = integrationDouble();
    relay.track(integration);
    const first = session();
    const [ref, other] = [binding(), binding()];
    relay.bind(first, integration, ref);
    relay.bind(first, integration, other);
    relay.suspend(first);

    publish({ binding: ref, event: { type: 'started', runId: 'run-1' } });
    publish({ binding: ref, event: rows(`tail:${'x'.repeat(1_200)}`) });
    publish({ binding: other, event: rows(`other:${'x'.repeat(500)}`) });
    const second = session();

    expect(relay.resume(second, integration, [{ binding: ref, acknowledgedSeq: 0 }]))
      .toEqual([{ bindingId: ref.id, replayThroughSeq: 1, launch: null, receivedRunIds: [] }]);
    expect(second.frames().map((frame) => frame.seq)).toEqual([1]);
    relay.dispose();
  });

  test('keeps the frame a resume reply names while pressure drops older rows', async () => {
    const relay = new ProducerRelay({ retainedBytes: 2_048 });
    const { integration, binding, publish } = integrationDouble();
    relay.track(integration);
    const first = session();
    const [ref, other] = [binding(), binding()];
    relay.bind(first, integration, ref);
    relay.bind(first, integration, other);
    relay.suspend(first);
    publish({ binding: ref, event: rows(`old:${'x'.repeat(600)}`) });
    publish({ binding: ref, event: rows(`tail:${'x'.repeat(600)}`) });
    const second = session(0);

    expect(relay.resume(second, integration, [{ binding: ref, acknowledgedSeq: 0 }])[0]!.replayThroughSeq).toBe(2);
    publish({ binding: other, event: rows(`other:${'x'.repeat(1_400)}`) });
    second.allow(5);
    await Bun.sleep(30);

    expect(second.texts().map((text) => text.split(':')[0])).toEqual(['tail']);
    expect(second.frames().map((frame) => frame.seq)).toEqual([2]);
    relay.dispose();
  });

  test('detaches a binding whose grace expires and no longer resumes it', async () => {
    const relay = new ProducerRelay({ graceMs: 10 });
    const { integration, binding, publish, detach } = integrationDouble();
    relay.track(integration);
    const first = session();
    const ref = binding();
    relay.bind(first, integration, ref);
    relay.suspend(first);
    publish({ binding: ref, event: rows('lost') });

    await Bun.sleep(30);

    expect(detach).toHaveBeenCalledWith(ref);
    const second = session();
    expect(relay.resume(second, integration, [{ binding: ref, acknowledgedSeq: 0 }])).toEqual([]);
    expect(second.sent).toEqual([]);
    relay.dispose();
  });

  test('shortens the grace of bindings a newer session does not resume', async () => {
    const relay = new ProducerRelay({ graceMs: 60_000, supersededGraceMs: 10 });
    const { integration, binding, detach } = integrationDouble();
    relay.track(integration);
    const first = session();
    const orphan = binding();
    const resumed = binding();
    relay.bind(first, integration, orphan);
    relay.bind(first, integration, resumed);
    relay.suspend(first);
    const second = session();

    relay.shortenSuspendedGrace();
    relay.resume(second, integration, [{ binding: resumed, acknowledgedSeq: 0 }]);
    await Bun.sleep(30);

    expect(detach).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledWith(orphan);
    expect(relay.owns(second, integration, resumed)).toBe(true);
    relay.dispose();
  });

  test('keeps an earlier expiry when a newer session starts', async () => {
    const relay = new ProducerRelay({ graceMs: 10, supersededGraceMs: 60_000 });
    const { integration, binding, detach } = integrationDouble();
    relay.track(integration);
    const first = session();
    const ref = binding();
    relay.bind(first, integration, ref);
    relay.suspend(first);

    relay.shortenSuspendedGrace();
    await Bun.sleep(30);

    expect(detach).toHaveBeenCalledWith(ref);
    relay.dispose();
  });

  test('keeps a resumed binding from expiring and ignores other sessions and integrations', async () => {
    const relay = new ProducerRelay({ graceMs: 10 });
    const owner = integrationDouble();
    const other = integrationDouble();
    relay.track(owner.integration);
    relay.track(other.integration);
    const first = session();
    const ref = owner.binding();
    relay.bind(first, owner.integration, ref);
    relay.suspend(first);
    const second = session();

    expect(relay.resume(second, other.integration, [{ binding: ref, acknowledgedSeq: 0 }])).toEqual([]);
    expect(relay.resume(second, owner.integration, [{ binding: ref, acknowledgedSeq: 0 }]).map((state) => state.bindingId))
      .toEqual([ref.id]);
    await Bun.sleep(30);
    expect(owner.detach).not.toHaveBeenCalled();
    expect(relay.owns(second, owner.integration, ref)).toBe(true);
    expect(relay.owns(first, owner.integration, ref)).toBe(false);
    relay.acknowledge(first, [{ bindingId: ref.id, seq: 1 }]);
    owner.publish({ binding: ref, event: rows('live') });
    expect(second.frames().map((frame) => frame.seq)).toEqual([1]);
    relay.dispose();
    expect(owner.listeners.size).toBe(0);
  });

  test('reports the latest launch on resume until its run ends', async () => {
    const relay = new ProducerRelay();
    const { integration, binding, publish } = integrationDouble();
    relay.track(integration);
    const first = session();
    const ref = binding();
    relay.bind(first, integration, ref);
    const handle = createAgentResourceRef(SCOPE, 'execution');
    const release = Promise.withResolvers<typeof handle>();
    const launch = relay.launch(first, integration, { producerBinding: ref, runId: 'run-1' }, new AbortController().signal, undeliveredReplies().observe, () => release.promise);
    relay.suspend(first);
    const second = session();

    expect(relay.resume(second, integration, [{ binding: ref, acknowledgedSeq: 0 }]))
      .toEqual([{ bindingId: ref.id, replayThroughSeq: 0, launch: { runId: 'run-1', handle: null }, receivedRunIds: ['run-1'] }]);
    release.resolve(handle);
    await launch;
    relay.suspend(second);
    const third = session();
    expect(relay.resume(third, integration, [{ binding: ref, acknowledgedSeq: 1 }])[0]!.launch)
      .toEqual({ runId: 'run-1', handle });
    publish({ binding: ref, event: { type: 'run-ended', runId: 'run-1', outcome: 'finished' } });
    relay.suspend(third);
    expect(relay.resume(session(), integration, [{ binding: ref, acknowledgedSeq: 2 }])[0]!.launch).toBeNull();
    relay.dispose();
  });

  test('reports the runs of the latest launches it received', async () => {
    const relay = new ProducerRelay();
    const { integration, binding } = integrationDouble();
    relay.track(integration);
    const first = session();
    const ref = binding();
    relay.bind(first, integration, ref);
    const handle = createAgentResourceRef(SCOPE, 'execution');
    for (let run = 1; run <= 10; run += 1) {
      await relay.launch(first, integration, { producerBinding: ref, runId: `run-${run}` }, new AbortController().signal, undeliveredReplies().observe, async () => handle);
    }
    await relay.launch(first, integration, { producerBinding: ref, runId: 'run-failed' }, new AbortController().signal, undeliveredReplies().observe, async () => {
      throw new Error('Synthetic launch failure');
    }).catch(() => null);
    relay.suspend(first);

    expect(relay.resume(session(), integration, [{ binding: ref, acknowledgedSeq: 0 }])[0]!.receivedRunIds)
      .toEqual(['run-4', 'run-5', 'run-6', 'run-7', 'run-8', 'run-9', 'run-10', 'run-failed']);
    relay.dispose();
  });

  test('publishes the outcome of a launch that settles after its session was lost', async () => {
    const relay = new ProducerRelay();
    const { integration, binding } = integrationDouble();
    relay.track(integration);
    const first = session();
    const [started, cancelled, failed] = [binding(), binding(), binding()];
    for (const ref of [started, cancelled, failed]) relay.bind(first, integration, ref);
    const handle = createAgentResourceRef(SCOPE, 'execution');
    const success = Promise.withResolvers<typeof handle>();
    const cancellation = Promise.withResolvers<typeof handle>();
    const failure = Promise.withResolvers<typeof handle>();
    const abandoned = new AbortController();
    const launches = [
      relay.launch(first, integration, { producerBinding: started, runId: 'run-1' }, new AbortController().signal, undeliveredReplies().observe, () => success.promise),
      relay.launch(first, integration, { producerBinding: cancelled, runId: 'run-2' }, abandoned.signal, undeliveredReplies().observe, () => cancellation.promise)
        .catch(() => null),
      relay.launch(first, integration, { producerBinding: failed, runId: 'run-3' }, new AbortController().signal, undeliveredReplies().observe, () => failure.promise)
        .catch(() => null),
    ];
    relay.suspend(first);
    abandoned.abort();
    success.resolve(handle);
    cancellation.reject(new Error('Synthetic cancelled admission'));
    failure.reject(new AgentIntegrationError('AUTH_REQUIRED', 'Synthetic sign-in required', false));
    await Promise.all(launches);
    const second = session();
    relay.resume(second, integration, [
      { binding: started, acknowledgedSeq: 0 },
      { binding: cancelled, acknowledgedSeq: 0 },
      { binding: failed, acknowledgedSeq: 0 },
    ]);

    expect(second.frames().map(({ notification }) => [notification.binding.id, notification.event])).toEqual([
      [started.id, { type: 'launch-settled', runId: 'run-1', handle }],
      [cancelled.id, { type: 'launch-settled', runId: 'run-2', error: EXECUTOR_DISCONNECTED_BEFORE_START }],
      [failed.id, { type: 'launch-settled', runId: 'run-3', error: { code: 'AUTH_REQUIRED', message: 'Synthetic sign-in required' } }],
    ]);
    relay.dispose();
  });

  test('cancels a launch in admission that the controller abandons or a newer launch replaces', async () => {
    const relay = new ProducerRelay();
    const { integration, binding } = integrationDouble();
    relay.track(integration);
    const live = session();
    const ref = binding();
    relay.bind(live, integration, ref);
    const signals: AbortSignal[] = [];
    const abandoned = relay.launch(live, integration, { producerBinding: ref, runId: 'run-1' }, new AbortController().signal, undeliveredReplies().observe, pendingAdmission(signals))
      .catch((error: unknown) => error);
    relay.cancelLaunch(integration, ref, 'run-other');
    expect(signals[0]!.aborted).toBe(false);
    relay.cancelLaunch(integration, ref, 'run-1');
    expect(signals[0]!.aborted).toBe(true);
    expect(await abandoned).toBeInstanceOf(Error);

    const replaced = relay.launch(live, integration, { producerBinding: ref, runId: 'run-2' }, new AbortController().signal, undeliveredReplies().observe, pendingAdmission(signals))
      .catch((error: unknown) => error);
    const handle = createAgentResourceRef(SCOPE, 'execution');
    const newest = relay.launch(live, integration, { producerBinding: ref, runId: 'run-3' }, new AbortController().signal, undeliveredReplies().observe, async () => handle);
    expect(signals[1]!.aborted).toBe(true);
    expect(await replaced).toBeInstanceOf(Error);
    expect(await newest).toBe(handle);
    relay.suspend(live);
    expect(relay.resume(session(), integration, [{ binding: ref, acknowledgedSeq: 0 }])[0]!.launch).toEqual({ runId: 'run-3', handle });
    relay.dispose();
  });

  test('aborts through its handle a launch that leaves admission after it was cancelled', async () => {
    const relay = new ProducerRelay();
    const { integration, binding, abort } = integrationDouble();
    relay.track(integration);
    const live = session();
    const ref = binding();
    relay.bind(live, integration, ref);
    const handle = createAgentResourceRef(SCOPE, 'execution');
    const release = Promise.withResolvers<void>();
    const launch = relay.launch(live, integration, { producerBinding: ref, runId: 'run-1' }, new AbortController().signal, undeliveredReplies().observe, async () => {
      await release.promise;
      return handle;
    });
    relay.cancelLaunch(integration, ref, 'run-1');
    release.resolve();

    await expect(launch).rejects.toThrow('The launch was cancelled before it started.');
    expect(abort).toHaveBeenCalledWith(handle);
    relay.dispose();
  });

  test('leaves the outcome of a launch settled on its own session to the reply', async () => {
    const relay = new ProducerRelay();
    const { integration, binding } = integrationDouble();
    relay.track(integration);
    const live = session();
    const ref = binding();
    relay.bind(live, integration, ref);
    const handle = createAgentResourceRef(SCOPE, 'execution');

    await expect(relay.launch(live, integration, { producerBinding: ref, runId: 'run-1' }, new AbortController().signal, undeliveredReplies().observe, async () => handle))
      .resolves.toBe(handle);
    await expect(relay.launch(live, integration, { producerBinding: ref, runId: 'run-2' }, new AbortController().signal, undeliveredReplies().observe, async () => {
      throw new Error('Synthetic rejection');
    })).rejects.toThrow('Synthetic rejection');

    expect(live.sent).toEqual([]);
    relay.dispose();
  });

  test('reports a launch that throws with a nested unknown outcome as a definite failure', async () => {
    const relay = new ProducerRelay();
    const { integration, binding } = integrationDouble();
    relay.track(integration);
    const live = session();
    const ref = binding();
    relay.bind(live, integration, ref);
    const nested = new AgentCallError('unknown', 'Synthetic credential read outcome is unknown');
    const untracked = binding();

    for (const producerBinding of [ref, untracked]) {
      await expect(relay.launch(live, integration, { producerBinding, runId: 'run-1' }, new AbortController().signal, undeliveredReplies().observe, async () => {
        throw nested;
      })).rejects.toMatchObject({ outcome: 'rejected', code: nested.code, message: nested.message });
    }
    relay.dispose();
  });

  test('publishes the outcome of a launch whose reply its live session could not take', async () => {
    const relay = new ProducerRelay();
    const { integration, binding } = integrationDouble();
    relay.track(integration);
    const live = session();
    const [started, failed] = [binding(), binding()];
    relay.bind(live, integration, started);
    relay.bind(live, integration, failed);
    const handle = createAgentResourceRef(SCOPE, 'execution');
    const success = undeliveredReplies();
    const failure = undeliveredReplies();

    await relay.launch(live, integration, { producerBinding: started, runId: 'run-1' }, new AbortController().signal, success.observe, async () => handle);
    await relay.launch(live, integration, { producerBinding: failed, runId: 'run-2' }, new AbortController().signal, failure.observe, async () => {
      throw new AgentIntegrationError('AUTH_REQUIRED', 'Synthetic sign-in required', false);
    }).catch(() => null);
    expect(live.sent).toEqual([]);
    success.fire();
    failure.fire();

    expect(live.frames().map(({ notification }) => [notification.binding.id, notification.event])).toEqual([
      [started.id, { type: 'launch-settled', runId: 'run-1', handle }],
      [failed.id, { type: 'launch-settled', runId: 'run-2', error: { code: 'AUTH_REQUIRED', message: 'Synthetic sign-in required' } }],
    ]);
    relay.dispose();
  });
});
