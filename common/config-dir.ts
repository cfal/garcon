import { homedir } from 'node:os';
import path from 'node:path';

export interface ConfigDirectoryEnvironment {
  GARCON_CONFIG_DIR?: string;
  HOME?: string;
}

// Windows ignores HOME: Git Bash, MSYS, and agent sandboxes set it inconsistently, so
// launches from different shells would otherwise resolve different config roots.
export function resolveHomeDirectory(
  home: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') return homedir();
  return home || homedir();
}

export function resolveConfigDirectory(
  explicit: string | undefined,
  environment: ConfigDirectoryEnvironment = { GARCON_CONFIG_DIR: process.env.GARCON_CONFIG_DIR, HOME: process.env.HOME },
  platform: NodeJS.Platform = process.platform,
): string {
  const value = explicit ?? (environment.GARCON_CONFIG_DIR || undefined)
    ?? path.join(resolveHomeDirectory(environment.HOME, platform), '.garcon');
  if (!value.trim()) throw new Error('--config-dir must be a non-empty directory path');
  return path.resolve(value);
}
