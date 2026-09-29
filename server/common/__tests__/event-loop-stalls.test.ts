import { expect, mock, test } from 'bun:test';
import { monitorEventLoopStalls } from '../event-loop-stalls.js';

function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* Holds the event loop. */ }
}

test('reports a stall longer than the threshold once and stays quiet otherwise', async () => {
  const onStall = mock((_stallMs: number) => undefined);
  const stop = monitorEventLoopStalls(onStall, { intervalMs: 20, thresholdMs: 150 });
  try {
    await Bun.sleep(100);
    expect(onStall).not.toHaveBeenCalled();

    block(300);
    await Bun.sleep(60);

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0]![0]).toBeGreaterThanOrEqual(150);
  } finally {
    stop();
  }
});

test('stops sampling once stopped', async () => {
  const onStall = mock((_stallMs: number) => undefined);
  const stop = monitorEventLoopStalls(onStall, { intervalMs: 20, thresholdMs: 50 });
  stop();
  block(120);
  await Bun.sleep(60);
  expect(onStall).not.toHaveBeenCalled();
});
