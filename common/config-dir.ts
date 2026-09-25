import { homedir } from 'node:os';
import path from 'node:path';

export interface ConfigDirectoryEnvironment {
  GARCON_CONFIG_DIR?: string;
  HOME?: string;
}

export function resolveConfigDirectory(
  explicit: string | undefined,
  environment: ConfigDirectoryEnvironment = { GARCON_CONFIG_DIR: process.env.GARCON_CONFIG_DIR, HOME: process.env.HOME },
): string {
  const value = explicit ?? (environment.GARCON_CONFIG_DIR || undefined)
    ?? path.join(environment.HOME || homedir(), '.garcon');
  if (!value.trim()) throw new Error('--config-dir must be a non-empty directory path');
  return path.resolve(value);
}
