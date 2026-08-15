import { describe, expect, test } from 'bun:test';
import { AgentRunTracker } from '../run-tracker.js';
import type { AgentRuntimeEvent } from '../runtime-events.js';

function collector() {
  const events: AgentRuntimeEvent[] = [];
  return { events, publish: (event: AgentRuntimeEvent) => { events.push(event); } };
}

const CONTENT = { type: 'messages', rows: [], runId: null } satisfies AgentRuntimeEvent;

describe('AgentRunTracker routing', () => {
  test('routes a named event to the run that produced it, not the one running now', () => {
    const tracker = new AgentRunTracker();
    const before = collector();
    const after = collector();
    tracker.register('chat-1', 'run-1', before.publish);
    tracker.register('chat-1', 'run-2', after.publish);

    tracker.correlate('chat-1', { turnId: 'run-1' })?.publish(CONTENT);

    expect(before.events).toHaveLength(1);
    expect(after.events).toHaveLength(0);
  });

  test('keeps one session routable through two publishers', () => {
    const tracker = new AgentRunTracker();
    const first = collector();
    const second = collector();
    tracker.register('chat-1', 'run-1', first.publish);
    tracker.register('chat-1', 'run-2', second.publish);

    tracker.correlate('chat-1', { clientRequestId: 'run-1' })?.publish(CONTENT);
    tracker.correlate('chat-1', { clientRequestId: 'run-2' })?.publish(CONTENT);

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
  });

  test('keeps a route after its run ends so late content still reaches the transcript', () => {
    const tracker = new AgentRunTracker();
    const run = collector();
    tracker.register('chat-1', 'run-1', run.publish);
    tracker.finish('chat-1', 'run-1');

    expect(tracker.current('chat-1')).toBeNull();
    tracker.correlate('chat-1')?.publish(CONTENT);
    tracker.correlate('chat-1', { turnId: 'run-1' })?.publish(CONTENT);

    expect(run.events).toHaveLength(2);
  });

  test('reports no route for a name it never registered rather than guessing', () => {
    const tracker = new AgentRunTracker();
    const run = collector();
    tracker.register('chat-1', 'run-1', run.publish);

    expect(tracker.correlate('chat-1', { turnId: 'run-unknown' })).toBeNull();
    expect(tracker.correlate('chat-2')).toBeNull();
    expect(run.events).toHaveLength(0);
  });

  test('retires the oldest routes once a chat accumulates enough of them', () => {
    const tracker = new AgentRunTracker();
    const first = collector();
    tracker.register('chat-1', 'run-0', first.publish);
    for (let index = 1; index <= 8; index += 1) {
      tracker.register('chat-1', `run-${index}`, collector().publish);
    }

    expect(tracker.correlate('chat-1', { turnId: 'run-0' })).toBeNull();
    expect(tracker.correlate('chat-1', { turnId: 'run-8' })).not.toBeNull();
  });

  test('hands a goal-control successor the route its predecessor was using', () => {
    const tracker = new AgentRunTracker();
    const predecessor = collector();
    const unrelated = collector();
    tracker.register('chat-1', 'run-1', predecessor.publish);
    const handoff = tracker.handoff('chat-1', 'run-1', 'run-2', unrelated.publish, {
      validate: () => undefined,
      commit: () => undefined,
    });
    handoff.commit();

    tracker.correlate('chat-1', { turnId: 'run-2' })?.publish(CONTENT);

    expect(predecessor.events).toHaveLength(1);
    expect(unrelated.events).toHaveLength(0);
  });
});
