import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { hasNodeErrorCode } from '../lib/errors.js';

export function ensureLedgerRootDirectory(rootDirectory: string): string {
  mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  return realpathSync(rootDirectory);
}

export function ensureLedgerChatDirectory(rootDirectory: string, chatId: string): string {
  const directory = path.join(rootDirectory, chatId);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!hasNodeErrorCode(error, 'EEXIST')) throw error;
  }

  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Transcript ledger path is not a directory: ${directory}`);
  }

  const canonicalDirectory = realpathSync(directory);
  if (path.dirname(canonicalDirectory) !== rootDirectory) {
    throw new Error(`Transcript ledger path escapes its root: ${directory}`);
  }

  chmodSync(canonicalDirectory, 0o700);
  return canonicalDirectory;
}
