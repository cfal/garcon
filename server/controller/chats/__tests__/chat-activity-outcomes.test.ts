import { expect, test } from 'bun:test';
import { ChatActivityOutcomes } from '../chat-activity-outcomes.js';

for (const outcome of ['finished', 'failed', 'interrupted'] as const) {
  test.each(['before-clear', 'after-clear'])(`retains ${outcome} terminal authority when publishing %s`, timing => {
    const outcomes = new ChatActivityOutcomes(() => 'view-1');
    outcomes.begin('chat', 'run-1');
    const terminal = outcomes.captureTerminal('chat', 'view-1', 'run-1');
    if (timing === 'before-clear') expect(outcomes.commit(terminal, outcome)).toBe(true);
    outcomes.clear('chat');
    if (timing === 'after-clear') expect(outcomes.commit(terminal, outcome)).toBe(false);
    expect(outcomes.fail(outcomes.captureFailure('chat', 'run-1'))).toBe(false);
    expect(outcomes.get('chat')).toBeNull();
  });
}

test('a committed terminal fences a failure already waiting for settlement', () => {
  const outcomes = new ChatActivityOutcomes(() => 'view-1');
  outcomes.begin('chat', 'run-1');
  const failure = outcomes.captureFailure('chat', 'run-1');
  const terminal = outcomes.captureTerminal('chat', 'view-1', 'run-1');
  expect(outcomes.fail(failure)).toBe(false);
  expect(outcomes.commit(terminal, 'finished')).toBe(true);
  expect(outcomes.get('chat')).toBe('finished');
});

test('terminal observation fences cold repair before display publication', () => {
  const outcomes = new ChatActivityOutcomes(() => 'view-1');
  const repair = outcomes.captureRepair('chat');
  if (!repair) throw new Error('Expected cold repair attempt');
  const terminal = outcomes.captureTerminal('chat', 'view-1', 'run-1');
  expect(outcomes.captureRepair('chat')).toBeNull();
  outcomes.restore(repair, 'failed');
  expect(outcomes.get('chat')).toBeNull();
  expect(outcomes.commit(terminal, 'finished')).toBe(true);
});

test('queued acceptance does not discard a still-running turn failure', () => {
  const outcomes = new ChatActivityOutcomes(() => 'view-1');
  outcomes.begin('chat', 'run-1');
  outcomes.clear('chat');
  expect(outcomes.fail(outcomes.captureFailure('chat', 'run-1'))).toBe(true);
  expect(outcomes.get('chat')).toBe('failed');
});

test('view replacement retains the originating-run fence until a new run starts', () => {
  let view = 'view-1';
  const outcomes = new ChatActivityOutcomes(() => view);
  outcomes.begin('chat', 'run-1');
  const failure = outcomes.captureFailure('chat', 'run-1');
  view = 'view-2';
  outcomes.invalidateView('chat');
  expect(outcomes.fail(failure)).toBe(false);
  expect(outcomes.fail(outcomes.captureFailure('chat', 'run-1'))).toBe(false);
  expect(outcomes.captureTerminal('chat', 'view-1', 'run-1')).toBeNull();
  outcomes.begin('chat', 'run-2');
  expect(outcomes.fail(outcomes.captureFailure('chat', 'run-2'))).toBe(true);
});

test('late terminals and failures cannot replace a successor result', () => {
  const outcomes = new ChatActivityOutcomes(() => 'view-1');
  outcomes.begin('chat', 'run-1');
  const oldTerminal = outcomes.captureTerminal('chat', 'view-1', 'run-1');
  outcomes.begin('chat', 'run-2');
  const terminal = outcomes.captureTerminal('chat', 'view-1', 'run-2');
  expect(outcomes.commit(terminal, 'finished')).toBe(true);
  expect(outcomes.commit(oldTerminal, 'failed')).toBe(false);
  expect(outcomes.captureTerminal('chat', 'view-1', 'run-1')).toBeNull();
  expect(outcomes.fail(outcomes.captureFailure('chat', 'run-1'))).toBe(false);
  expect(outcomes.get('chat')).toBe('finished');
});

test('deletion retires captured work and forgets run identity', () => {
  const outcomes = new ChatActivityOutcomes(() => 'view-1');
  outcomes.begin('chat', 'run-1');
  const terminal = outcomes.captureTerminal('chat', 'view-1', 'run-1');
  outcomes.delete('chat');
  expect(outcomes.commit(terminal, 'finished')).toBe(false);
  expect(outcomes.fail(outcomes.captureFailure('chat', 'run-2'))).toBe(true);
});

test('a run begun before adoption accepts its own failure but fences an earlier run', () => {
  let view: string | null = null;
  const outcomes = new ChatActivityOutcomes(() => view);
  outcomes.begin('chat', 'old-run');
  outcomes.begin('chat', 'new-run');
  view = 'adopted-view';
  expect(outcomes.fail(outcomes.captureFailure('chat', 'old-run'))).toBe(false);
  expect(outcomes.fail(outcomes.captureFailure('chat', 'new-run'))).toBe(true);
});

test('a repeated begin cannot revive a terminal or rebind it to a replacement view', () => {
  let view = 'view-1';
  const outcomes = new ChatActivityOutcomes(() => view);
  outcomes.begin('chat', 'run-1');
  outcomes.captureTerminal('chat', view, 'run-1');
  outcomes.clear('chat', 'run-1');
  expect(outcomes.fail(outcomes.captureFailure('chat', 'run-1'))).toBe(false);
  view = 'view-2';
  outcomes.invalidateView('chat');
  outcomes.begin('chat', 'run-1');
  expect(outcomes.captureTerminal('chat', view, 'run-1')).toBeNull();
  expect(outcomes.fail(outcomes.captureFailure('chat', 'run-1'))).toBe(false);
});

test('replacement retires a run whose initial view was unavailable', () => {
  let view: string | null = null;
  const outcomes = new ChatActivityOutcomes(() => view);
  outcomes.begin('chat', 'run-1');
  outcomes.invalidateView('chat');
  view = 'replacement-view';
  expect(outcomes.fail(outcomes.captureFailure('chat', 'run-1'))).toBe(false);
  expect(outcomes.captureTerminal('chat', view, 'run-1')).toBeNull();
});
