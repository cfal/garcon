import { expect, mock, test } from 'bun:test';
import { monitorEventLoopStalls } from '../event-loop-stalls.js';

function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* Holds the event loop. */ }
}

test('reports a stall longer than the threshold once and stays quiet otherwise', async () => {
  const warn = mock((..._args: unknown[]) => undefined);
  const stop = monitorEventLoopStalls({ warn }, { intervalMs: 20, thresholdMs: 150 });
  try {
    await Bun.sleep(100);
    expect(warn).not.toHaveBeenCalled();

    block(300);
    await Bun.sleep(60);

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, detail] = warn.mock.calls[0]!;
    expect(message).toBe('Event loop stalled');
    expect((detail as { stallMs: number }).stallMs).toBeGreaterThanOrEqual(150);
  } finally {
    stop();
  }
});

test('stops sampling once stopped', async () => {
  const warn = mock((..._args: unknown[]) => undefined);
  const stop = monitorEventLoopStalls({ warn }, { intervalMs: 20, thresholdMs: 50 });
  stop();
  block(120);
  await Bun.sleep(60);
  expect(warn).not.toHaveBeenCalled();
});
