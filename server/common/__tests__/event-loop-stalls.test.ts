import { expect, mock, test } from 'bun:test';
import { monitorEventLoopStalls, trackActivity, withActivity, type EventLoopStall } from '../event-loop-stalls.js';

function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* Holds the event loop. */ }
}

test('reports a stall longer than the threshold once and stays quiet otherwise', async () => {
  const onStall = mock((_stall: EventLoopStall) => undefined);
  const stop = monitorEventLoopStalls(onStall, { intervalMs: 20, thresholdMs: 150 });
  try {
    await Bun.sleep(100);
    expect(onStall).not.toHaveBeenCalled();

    block(300);
    await Bun.sleep(60);

    expect(onStall).toHaveBeenCalledTimes(1);
    const stall = onStall.mock.calls[0]![0];
    expect(stall.stallMs).toBeGreaterThanOrEqual(150);
    expect(stall.heapUsedMb).toBeGreaterThan(0);
  } finally {
    stop();
  }
});

test('stops sampling once stopped', async () => {
  const onStall = mock((_stall: EventLoopStall) => undefined);
  const stop = monitorEventLoopStalls(onStall, { intervalMs: 20, thresholdMs: 50 });
  stop();
  block(120);
  await Bun.sleep(60);
  expect(onStall).not.toHaveBeenCalled();
});

test('names the activity that held the loop and still-running work, not work that ended before', async () => {
  const stalls: EventLoopStall[] = [];
  const stop = monitorEventLoopStalls((stall) => stalls.push(stall), { intervalMs: 20, thresholdMs: 150 });
  const finishEarlier = trackActivity('synthetic earlier work');
  finishEarlier();
  const finishRunning = trackActivity('synthetic running work');
  try {
    await Bun.sleep(60);
    await withActivity('synthetic blocking work', () => block(300));
    await Bun.sleep(60);

    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.activities).toEqual(['synthetic blocking work', 'synthetic running work']);
  } finally {
    finishRunning();
    stop();
  }
});
