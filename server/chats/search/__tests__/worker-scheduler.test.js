import { describe, expect, it } from 'bun:test';
import { TranscriptSearchWorkerScheduler } from '../worker-scheduler.js';

describe('TranscriptSearchWorkerScheduler', () => {
  it('cancels the full duty-cycle pause when interactive work arrives', async () => {
    let now = 0;
    const sleepCalls = [];
    let wakeSleep = null;
    const scheduler = new TranscriptSearchWorkerScheduler({
      now: () => now,
      sleep(delayMs) {
        sleepCalls.push(delayMs);
        return new Promise((resolve) => {
          wakeSleep = resolve;
        });
      },
    });
    let pauseStarted;
    const started = new Promise((resolve) => {
      pauseStarted = resolve;
    });

    const result = scheduler.runBackground(async (yieldAfterSlice) => {
      now = 1_000;
      const pause = yieldAfterSlice();
      pauseStarted();
      await pause;
      return 'done';
    });
    await started;
    scheduler.wakeInteractive();

    await expect(result).resolves.toBe('done');
    expect(sleepCalls[0]).toBe(500);
    expect(sleepCalls.filter((delay) => delay === 500)).toHaveLength(1);
    scheduler.wakeInteractive();
    wakeSleep?.();
  });
});
