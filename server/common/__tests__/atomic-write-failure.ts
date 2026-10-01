import { spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';

export async function withFailingDirectorySync<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const open = fs.open;
  const failure = spyOn(fs, 'open').mockImplementation(async (target, flags, ...rest) => {
    if (target === directory && flags === 'r') throw new Error('Synthetic directory sync failure');
    return open(target, flags, ...rest);
  });
  try { return await operation(); }
  finally { failure.mockRestore(); }
}
