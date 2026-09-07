import { lstatSync, statSync } from 'node:fs';

export function statSizeIfExists(filePath: string): number | null {
  try {
    return statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function lstatIfExists(filePath: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
