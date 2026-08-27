import { statSync } from 'node:fs';

export function statSizeIfExists(filePath: string): number | null {
  try {
    return statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
