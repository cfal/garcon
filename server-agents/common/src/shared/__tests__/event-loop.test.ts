import { expect, spyOn, test } from 'bun:test';
import { EventLoopSteps, forEachInSteps } from '../event-loop.js';

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* synthetic per-item cost */ }
}

test('visits every item in order while bounding each step by elapsed time', async () => {
  const visited: number[] = [];
  let last = performance.now();
  let longestGap = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    longestGap = Math.max(longestGap, now - last);
    last = now;
  }, 1);
  await forEachInSteps(Array.from({ length: 60 }, (_, index) => index), (index) => {
    busyWait(2);
    visited.push(index);
  });
  // A final synchronous stretch ends before the probe runs again, so it gets one more turn.
  await new Promise((resolve) => setTimeout(resolve, 5));
  clearInterval(probe);

  expect(visited).toEqual(Array.from({ length: 60 }, (_, index) => index));
  expect(longestGap).toBeLessThan(60);
});

test('finishes cheap work without yielding', async () => {
  let turns = 0;
  const counter = setImmediate(() => { turns += 1; });
  await forEachInSteps([1, 2, 3], () => {});
  clearImmediate(counter);
  expect(turns).toBe(0);
});

test('consecutive passes on shared steps yield once their combined work uses the budget', async () => {
  let now = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  let turns = 0;
  const counter = setImmediate(() => { turns += 1; });
  try {
    const steps = new EventLoopSteps();
    await steps.forEach([1, 2], () => { now += 4; });
    expect(turns).toBe(0);
    await steps.forEach([3], () => { now += 4; });
    expect(turns).toBe(1);
  } finally {
    clearImmediate(counter);
    clock.mockRestore();
  }
});
