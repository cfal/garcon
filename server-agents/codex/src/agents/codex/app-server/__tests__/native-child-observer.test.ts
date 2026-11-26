import { expect, test } from 'bun:test';
import { runtimeOperation, type AgentRuntimeEvent } from '@garcon/server-agent-common/execution/runtime-events';
import { NATIVE_CHILD_CAPTURE_LIMITS } from '@garcon/server-agent-common/execution/native-child-capture-budget';
import { CodexNativeChildObserver } from '../native-child-observer.js';
import type { JsonRpcNotification } from '../protocol.js';

function fixture() {
  const events: AgentRuntimeEvent[] = [];
  const operation = runtimeOperation('run-a', event => { events.push(event); });
  const cancellation = new AbortController();
  const observer = new CodexNativeChildObserver({ codexHome: '/synthetic/codex', rootThreadId: 'root-a' });
  observer.bind(cancellation.signal, operation.publish);
  const send = (method: string, threadId: string, params: Record<string, unknown> = {}) =>
    observer.acceptSafely({ method, params: { threadId, ...params } }, operation);
  const spawn = (child = 'child-a', parent = 'root-a', kind = 'started') => send('item/completed', parent, {
    turnId: 'turn-a', item: { type: 'subAgentActivity', id: `spawn-${child}`, kind,
      agentThreadId: child, agentPath: `/root/${child}`, model: 'synthetic-model', reasoningEffort: 'low' },
  });
  const item = (id = 'item-a', child = 'child-a', content = 'Synthetic response') => send('item/completed', child, {
    turnId: 'turn-a', item: { type: 'agentMessage', id, text: content, phase: 'final_answer' },
  });
  const turn = (method: string, id = 'turn-a', status = 'completed') => send(method, 'child-a', { turn: { id, status, items: [] } });
  return { observer, operation, cancellation, events, send, spawn, item, turn };
}

test('admits V2 new children once, drains early content, and retains provider user input', () => {
  const f = fixture();
  expect(f.item()).toBe(true);
  expect(f.spawn()).toBe(false);
  f.spawn();
  f.item();
  f.send('item/completed', 'child-a', { turnId: 'turn-a', item: {
    type: 'userMessage', id: 'input-a', content: [{ type: 'text', text: 'Actual kickoff', text_elements: [] }],
  } });
  expect(f.events.filter(event => event.type === 'native-child-created')).toHaveLength(1);
  expect(f.events.filter(event => event.type === 'native-child-rows')).toHaveLength(2);
  expect(f.events.at(-1)).toMatchObject({ rows: [{ message: { type: 'user-message', content: 'Actual kickoff' } }] });
});

test('nested creation requires a verified emitting child, not a path-shaped label', () => {
  const f = fixture();
  f.spawn('child-a');
  f.spawn('child-b', 'child-a');
  const created = f.events.filter(event => event.type === 'native-child-created');
  expect(created).toHaveLength(2);
  expect(created[1]?.child.parentKey).toBe(created[0]?.child.ref.key);
  expect(created[1]?.child.ref.value).toMatchObject({ rootThreadId: 'root-a', parentThreadId: 'child-a' });
});

test.each(['interacted', 'interrupted', 'completed'])('does not discover from %s activity', kind => {
  const f = fixture();
  f.spawn('child-a', 'root-a', kind);
  expect(f.events).toEqual([]);
});

test.each(['interacted', 'interrupted', 'completed'])('keeps early content eligible when %s activity precedes the spawn', kind => {
  const f = fixture();
  f.item();
  f.turn('turn/started');
  f.turn('turn/completed');
  f.spawn('child-a', 'root-a', kind);
  f.spawn();
  expect(f.events.filter(event => event.type === 'native-child-created')).toHaveLength(1);
  expect(f.events.filter(event => event.type === 'native-child-rows')).toHaveLength(1);
  expect(f.events.at(-1)).toMatchObject({ type: 'native-child-status', status: 'completed' });
  expect(f.observer.ownsNativeWork).toBe(kind === 'interacted');
});

test.each(['attached', 'detached', 'unrouted-parent'])('a late spawn cannot reactivate an observed terminal (%s)', capture => {
  const f = fixture();
  if (capture === 'detached') f.cancellation.abort();
  f.turn('turn/started');
  f.turn('turn/completed');
  f.spawn('child-a', capture === 'unrouted-parent' ? 'unknown-parent' : 'root-a');
  expect(f.observer.ownsNativeWork).toBe(false);
  f.spawn('child-a', 'root-a', 'interacted');
  expect(f.observer.ownsNativeWork).toBe(true);
});

test('legacy discovery requires successful spawn and the exact parent identity', () => {
  const f = fixture();
  const item = { type: 'collabAgentToolCall', id: 'call-a', tool: 'spawnAgent', status: 'completed',
    senderThreadId: 'root-a', receiverThreadIds: ['child-a'], prompt: null, agentsStates: {} };
  f.send('item/completed', 'root-a', { item: { ...item, status: 'inProgress' }, turnId: 'turn-a' });
  f.send('item/completed', 'root-a', { item: { ...item, senderThreadId: 'unrelated' }, turnId: 'turn-a' });
  f.send('item/completed', 'root-a', { item, turnId: 'turn-a' });
  expect(f.events.filter(event => event.type === 'native-child-created')).toHaveLength(1);
});

test('tracks child activity independently of capture, with exact terminal turn matching', () => {
  const f = fixture();
  f.spawn();
  f.turn('turn/started', 'new-turn', 'inProgress');
  f.cancellation.abort();
  f.turn('turn/completed', 'old-turn');
  expect(f.observer.ownsNativeWork).toBe(true);
  f.turn('turn/completed', 'new-turn');
  expect(f.observer.ownsNativeWork).toBe(false);
  const count = f.events.length;
  f.item('late');
  expect(f.events).toHaveLength(count);
});

test.each([true, false])('follow-up admission remains busy across terminals (capture attached: %s)', attached => {
  const f = fixture();
  f.spawn();
  f.turn('turn/started');
  f.turn('turn/completed');
  expect(f.observer.ownsNativeWork).toBe(false);
  if (!attached) f.cancellation.abort();
  f.spawn('child-a', 'root-a', 'interacted');
  expect(f.observer.ownsNativeWork).toBe(true);
  f.turn('turn/started', 'followup');
  f.turn('turn/completed', 'followup');
  expect(f.observer.ownsNativeWork).toBe(true);
  expect(f.events.filter(event => event.type === 'native-child-created')).toHaveLength(1);
});

test.each(['sendInput', 'resumeAgent'])('legacy %s admission is not discharged by a child terminal', tool => {
  const f = fixture();
  f.cancellation.abort();
  f.send('item/started', 'root-a', { turnId: 'root-turn', item: { type: 'collabAgentToolCall',
    id: 'followup', tool, status: 'inProgress', senderThreadId: 'root-a', receiverThreadIds: ['old-child'],
    agentsStates: {}, prompt: null } });
  expect(f.observer.ownsNativeWork).toBe(true);
  f.send('turn/completed', 'old-child', { turn: { id: 'completed', status: 'completed', items: [] } });
  expect(f.observer.ownsNativeWork).toBe(true);
  expect(f.events).toEqual([]);
});

test('new child admission fences native idle even when capture has already detached', () => {
  const f = fixture();
  f.cancellation.abort();
  f.spawn();
  expect(f.observer.ownsNativeWork).toBe(true);
  f.turn('turn/started');
  f.turn('turn/completed');
  expect(f.observer.ownsNativeWork).toBe(false);
  f.spawn();
  expect(f.observer.ownsNativeWork).toBe(false);
  expect(f.events).toEqual([]);
});

test.each([true, false])('malformed terminal statuses never establish native idle (capture attached: %s)', attached => {
  for (const status of [['completed'], { status: 'completed' }, null, 1]) {
    const f = fixture();
    f.spawn();
    f.turn('turn/started');
    if (!attached) f.cancellation.abort();
    f.send('turn/completed', 'child-a', { turn: { id: 'turn-a', status, items: [] } });
    expect(f.observer.ownsNativeWork).toBe(true);
    f.turn('turn/completed');
    expect(f.observer.ownsNativeWork).toBe(true);
  }
});

test('unproven malformed lifecycle cannot establish native idle', () => {
  const f = fixture();
  f.spawn();
  f.turn('turn/completed', 'turn-a', 'unknown');
  expect(f.observer.ownsNativeWork).toBe(true);
  expect(f.events.some(event => event.type === 'native-child-gap')).toBe(true);
});

test('rebinding cannot reattach a previously observed child', () => {
  const f = fixture();
  f.spawn();
  f.cancellation.abort();
  f.observer.bind(new AbortController().signal, f.operation.publish);
  f.spawn();
  f.spawn('child-a', 'root-a', 'interacted');
  f.item();
  expect(f.events.filter(event => event.type === 'native-child-created')).toHaveLength(1);
  expect(f.events.filter(event => event.type === 'native-child-rows')).toEqual([]);
  f.spawn('child-b');
  expect(f.events.filter(event => event.type === 'native-child-created')).toHaveLength(2);
});

test('malformed child content retires only capture; unrelated partial root items are ignored', () => {
  const f = fixture();
  expect(f.send('item/started', 'root-a', { item: { type: 'agentMessage', id: 'partial' } })).toBe(false);
  expect(f.events).toEqual([]);
  f.spawn();
  expect(() => f.send('item/completed', 'child-a', { item: null })).not.toThrow();
  f.item('late');
  expect(f.events.some(event => event.type === 'native-child-detached')).toBe(true);
  expect(f.events.some(event => event.type === 'native-child-rows')).toBe(false);
  expect(f.observer.ownsNativeWork).toBe(true);
});

test('publisher failures never claim or disrupt ordinary root processing', () => {
  const f = fixture();
  const operation = runtimeOperation('throwing', () => { throw new Error('Synthetic failure'); });
  f.observer.bind(new AbortController().signal, operation.publish);
  const notification: JsonRpcNotification = { method: 'item/completed', params: { threadId: 'root-a', turnId: 'turn-a',
    item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child-a', agentPath: '/root/child' },
  } };
  expect(f.observer.acceptSafely(notification, operation)).toBe(false);
  expect(() => f.observer.dispose()).not.toThrow();
});

test('early overflow and identity overflow retire capture without silent replay acceptance', () => {
  const early = fixture();
  for (let index = 0; index <= NATIVE_CHILD_CAPTURE_LIMITS.earlyPerChild; index++) early.item(`early-${index}`);
  early.spawn();
  expect(early.events.some(event => event.type === 'native-child-created')).toBe(false);
  const live = fixture();
  live.spawn();
  for (let index = 0; index <= NATIVE_CHILD_CAPTURE_LIMITS.identitiesPerChild; index++) live.item(`item-${index}`);
  live.item('item-0');
  expect(live.events.filter(event => event.type === 'native-child-rows')).toHaveLength(NATIVE_CHILD_CAPTURE_LIMITS.identitiesPerChild);
  expect(live.events.at(-1)?.type).toBe('native-child-detached');
});

test.each([true, false])('unknown child pressure preserves captured siblings (continuation known: %s)', continuation => {
  const f = fixture();
  f.spawn('captured');
  for (let index = 0; index < 10; index++) {
    const child = `unknown-${index}`;
    f.item('early', child, 'x'.repeat(900_000));
    if (continuation) f.spawn(child, 'root-a', 'interacted');
  }
  f.item('late', 'captured');
  expect(f.events.filter(event => event.type === 'native-child-created')).toHaveLength(1);
  expect(f.events.filter(event => event.type === 'native-child-rows')).toHaveLength(1);
  expect(f.events.some(event => event.type === 'native-child-detached')).toBe(false);
  expect(f.events.some(event => event.type === 'native-child-gap')).toBe(true);
});
