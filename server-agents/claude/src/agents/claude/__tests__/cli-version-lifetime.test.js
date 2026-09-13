import { describe, expect, it, mock, spyOn } from 'bun:test';
import { ClaudeCliVersionProbe } from '../cli-version.js';

function probeFixture() {
  const exited = Promise.withResolvers();
  let stdout;
  let stderr;
  const process = {
    killed: false,
    exited: exited.promise,
    stdout: new ReadableStream({ start(controller) { stdout = controller; } }),
    stderr: new ReadableStream({ start(controller) { stderr = controller; } }),
    kill: mock(() => undefined),
  };
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => process);
  return { process, spawn, exited, stdout, stderr, probe: new ClaudeCliVersionProbe() };
}

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe('Claude CLI version probe lifetime', () => {
  for (const held of ['exit', 'stdout', 'stderr']) {
    it(`retains a shared probe through held ${held}`, async () => {
      const fake = probeFixture();
      try {
        const first = fake.probe.check('synthetic-claude');
        const second = fake.probe.check('synthetic-claude');
        expect(first.drained).toBe(second.drained);
        expect(fake.spawn).toHaveBeenCalledTimes(1);
        let drained = false;
        void first.drained.then(() => { drained = true; });
        fake.stdout.enqueue(new TextEncoder().encode('2.1.220'));
        if (held !== 'exit') fake.exited.resolve(0);
        if (held !== 'stdout') fake.stdout.close();
        if (held !== 'stderr') fake.stderr.close();
        await flush();
        expect(drained).toBe(false);

        if (held === 'exit') fake.exited.resolve(0);
        else if (held === 'stdout') fake.stdout.close();
        else fake.stderr.close();
        await first.drained;
        expect(await first.result).toEqual([2, 1, 220]);
        expect(await second.result).toEqual([2, 1, 220]);
        expect(fake.process.stdout.locked).toBe(false);
        expect(fake.process.stderr.locked).toBe(false);
      } finally { fake.spawn.mockRestore(); }
    });
  }

  it('keeps raw probe ownership after its deadline returns a failure', async () => {
    const fake = probeFixture();
    const timers = [];
    const set = spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    });
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => { timer.cancelled = true; });
    try {
      const check = fake.probe.check('synthetic-claude');
      const result = check.result.then(() => null, (error) => error);
      let drained = false;
      void check.drained.then(() => { drained = true; });
      for (const delay of [5_000, 1_000, 1_000]) {
        await flush();
        const timer = timers.shift();
        expect(timer.delay).toBe(delay);
        expect(timer.cancelled).toBe(false);
        timer.callback();
      }
      expect((await result).message).toContain('did not exit after SIGKILL');
      expect(fake.process.kill.mock.calls).toEqual([[], ['SIGKILL']]);
      expect(drained).toBe(false);
      fake.exited.resolve(137);
      fake.stdout.close();
      await flush();
      expect(drained).toBe(false);
      fake.stderr.close();
      await check.drained;
      expect(drained).toBe(true);
    } finally {
      set.mockRestore();
      clear.mockRestore();
      fake.spawn.mockRestore();
    }
  });

  for (const failed of ['exit', 'stdout', 'stderr']) {
    it(`rejects drainage when ${failed} observation fails`, async () => {
      const fake = probeFixture();
      try {
        const check = fake.probe.check('synthetic-claude');
        const result = check.result.then(() => null, (error) => error);
        const failure = new Error(`synthetic ${failed} failure`);
        let drained = false;
        const drainage = check.drained.then(() => null, (error) => error)
          .finally(() => { drained = true; });
        if (failed === 'exit') fake.exited.reject(failure);
        else fake.exited.resolve(0);
        if (failed === 'stdout') fake.stdout.error(failure);
        else fake.stdout.close();
        await flush();
        expect(drained).toBe(false);
        if (failed === 'stderr') fake.stderr.error(failure);
        else fake.stderr.close();
        expect(await drainage).toBe(failure);
        expect(await result).toBe(failure);
        expect(fake.process.stdout.locked).toBe(false);
        expect(fake.process.stderr.locked).toBe(false);
      } finally { fake.spawn.mockRestore(); }
    });
  }
});
