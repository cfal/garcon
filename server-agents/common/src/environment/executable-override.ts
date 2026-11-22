import { posix, win32 } from 'node:path';

// A child may run in a project, a temporary directory, or the user's home.
export function resolveExecutableOverride(command: string, platform: NodeJS.Platform = process.platform): string {
  const path = platform === 'win32' ? win32 : posix;
  if (path.isAbsolute(command) || path.basename(command) === command) return command;
  return path.resolve(command);
}
