import { describe, expect, it } from 'bun:test';
import { TranscriptSearchWorkerScheduler } from '../worker-scheduler.js';

describe('TranscriptSearchWorkerScheduler', () => {
  it('caps the full pause after a slow background slice', async () => {
    let now = 0;
    const sleepCalls = [];
    const scheduler = new TranscriptSearchWorkerScheduler({
      now: () => now,
      sleep: async (delayMs) => {
        sleepCalls.push(delayMs);
      },
    });

    await scheduler.runBackground(async (yieldAfterSlice) => {
      now = 1_000;
      await yieldAfterSlice();
    });

    expect(sleepCalls.filter((delay) => delay === 500)).toHaveLength(1);
  });

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

  it('does not resolve background work before pacing its final slice', async () => {
    let now = 0;
    let releasePause;
    let pauseStarted;
    const started = new Promise((resolve) => {
      pauseStarted = resolve;
    });
    const scheduler = new TranscriptSearchWorkerScheduler({
      now: () => now,
      sleep() {
        pauseStarted();
        return new Promise((resolve) => {
          releasePause = resolve;
        });
      },
    });

    let settled = false;
    const result = scheduler.runBackground(async () => {
      now = 100;
      return 'done';
    }).then((value) => {
      settled = true;
      return value;
    });

    await started;
    expect(settled).toBe(false);
    releasePause();

    await expect(result).resolves.toBe('done');
  });
});
