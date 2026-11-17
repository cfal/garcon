import { expect, spyOn, test } from 'bun:test';
import { DelayedExitProcess } from '../../lifecycle/__tests__/process-exit-conformance.js';

export function singleQueryIoConformance(query: (prompt: string) => Promise<string>): void {
  test.each([0, 1])('collects output before input and preserves process failure with exit %i', async exitCode => {
    const child = new DelayedExitProcess();
    child.pushStderr('Synthetic authentication failure');
    child.exit(exitCode);
    child.closeOutput();
    const write = spyOn(child.stdin, 'write').mockImplementation(() => {
      expect(child.stdout.locked).toBe(true);
      expect(child.stderr.locked).toBe(true);
      return Promise.reject(new Error('synthetic EPIPE'));
    });
    const spawn = spyOn(Bun, 'spawn').mockReturnValue(child);
    try {
      await expect(query('x'.repeat(512 * 1024))).rejects.toThrow(
        exitCode === 0 ? 'synthetic EPIPE' : 'command failed with code 1: Synthetic authentication failure',
      );
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
      spawn.mockRestore();
      await child[Symbol.asyncDispose]();
    }
  });
}
