import { describe, expect, it } from 'bun:test';
import path from 'node:path';

describe('carryover page codec', () => {
  it('cancels an active decode without an uncaught source-stream error', async () => {
    const fixture = path.join(import.meta.dir, 'fixtures', 'carryover-codec-abort.ts');
    const child = Bun.spawn([process.execPath, fixture], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  }, 30_000);
});
