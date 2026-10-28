import path from 'node:path';

export function isAbsoluteExecutorPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('\0')) return false;
  return path.posix.isAbsolute(value)
    || /^[a-z]:[\\/]/iu.test(value)
    || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(value);
}
