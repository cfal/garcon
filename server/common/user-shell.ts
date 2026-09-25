import os from 'node:os';

export function defaultUserShell(): string {
  return os.platform() === 'win32'
    ? 'powershell.exe'
    : (process.env.GARCON_TERMINAL_SHELL || process.env.SHELL || '/bin/bash');
}
