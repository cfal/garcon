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

  test('keeps a named route after its run ends so late content still reaches the transcript', () => {
    const tracker = new AgentRunTracker();
    const run = collector();
    tracker.register('chat-1', 'run-1', run.publish);
    tracker.finish('chat-1', 'run-1');

    expect(tracker.current('chat-1')).toBeNull();
    tracker.correlate('chat-1', { turnId: 'run-1' })?.publish(CONTENT);

    expect(run.events).toHaveLength(1);
  });

  test('refuses to attribute an event the provider did not name', () => {
    const tracker = new AgentRunTracker();
    const run = collector();
    tracker.register('chat-1', 'run-1', run.publish);

    expect(tracker.correlate('chat-1')).toBeNull();
    expect(tracker.correlate('chat-1', {})).toBeNull();
    expect(run.events).toHaveLength(0);
  });

  test('never lets one chat\u2019s name reach another chat\u2019s transcript', () => {
    const tracker = new AgentRunTracker();
    const chatA = collector();
    tracker.register('chat-a', 'run-1', chatA.publish);

    expect(tracker.correlate('chat-b', { turnId: 'run-1' })).toBeNull();
    expect(chatA.events).toHaveLength(0);
  });

  test('retires a chat\u2019s routes when a new session supersedes them', () => {
    const tracker = new AgentRunTracker();
    const old = collector();
    tracker.register('chat-1', 'run-1', old.publish);

    tracker.release('chat-1');

    expect(tracker.correlate('chat-1', { turnId: 'run-1' })).toBeNull();
    expect(tracker.current('chat-1')).toBeNull();
    expect(old.events).toHaveLength(0);
  });

  test('reports no route for a name it never registered rather than guessing', () => {
    const tracker = new AgentRunTracker();
    const run = collector();
    tracker.register('chat-1', 'run-1', run.publish);

    expect(tracker.correlate('chat-1', { turnId: 'run-unknown' })).toBeNull();
    expect(tracker.correlate('chat-2')).toBeNull();
    expect(run.events).toHaveLength(0);
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
