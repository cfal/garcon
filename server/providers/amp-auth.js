import { getAmpBinary } from '../config.js';

export async function getAmpAuthStatus() {
  try {
    const ampBinary = getAmpBinary();
    const proc = Bun.spawn([ampBinary, '--version'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    if (proc.exitCode === 0) {
      return { authenticated: true, canReauth: false, label: '' };
    }
    return { authenticated: false, canReauth: false, label: '' };
  } catch {
    return { authenticated: false, canReauth: false, label: '' };
  }
}
