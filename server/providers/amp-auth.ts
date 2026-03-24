import { getAmpBinary } from '../config.js';

export async function getAmpAuthStatus() {
  try {
    const ampBinary = getAmpBinary();
    const proc = Bun.spawn([ampBinary, 'usage'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    if (proc.exitCode === 0) {
      const stdout = await new Response(proc.stdout).text();
      const match = stdout.match(/Signed in as (\S+)/);
      return { authenticated: true, canReauth: false as const, label: match?.[1] ?? '' };
    }
    return { authenticated: false, canReauth: false as const, label: '' };
  } catch {
    return { authenticated: false, canReauth: false as const, label: '' };
  }
}
