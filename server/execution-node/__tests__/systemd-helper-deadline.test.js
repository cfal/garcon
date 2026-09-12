import { describe, expect, test } from 'bun:test';

async function fixture(mode, failure = 'none', timeout = '1000') {
  const child = Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null', `${import.meta.dir}/fixtures/helper-deadline-failure.ts`, mode, failure, timeout], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', timeout: 3_000, env: { BUN_OPTIONS: '--config=/dev/null' },
  });
  const [code, output, diagnostic] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, diagnostic).toBe(0);
  return { output: JSON.parse(output), calls: diagnostic.trim() ? JSON.parse(diagnostic) : [] };
}

describe.skipIf(process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))('systemd helper deadline setup', () => {
  test.each(['dlopen', 'signal', 'sigemptyset', 'sigaddset', 'pthread_sigmask'])('sanitizes %s failure before stdin or native bootstrap', async (failure) => {
    const result = await fixture('main', failure);
    expect(result.output).toEqual({ kind: 'failed', code: 'NODE_CONTAINMENT_UNAVAILABLE' });
    expect(result.calls.some(([name]) => ['stdin', 'bus', 'alarm'].includes(name))).toBe(false);
  });

  test.each(['0', '-1000', '1', 'NaN', 'Infinity', '4294967296000'])('invalid budget %s never disables the kernel deadline', async (timeout) => {
    expect((await fixture('arm', 'none', timeout)).output).toEqual({ armed: false, calls: [] });
  });

  test('restores default disposition, unblocks the signal and arms whole seconds', async () => {
    const result = await fixture('arm');
    expect(result.output).toEqual({ armed: true, calls: [['signal', 14, null], ['sigemptyset', 1], ['sigaddset', 1, 14],
      ['pthread_sigmask', 1, 1, null], ['alarm', 1], ['close']] });
  });
});
