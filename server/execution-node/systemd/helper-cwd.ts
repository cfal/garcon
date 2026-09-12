import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { SystemdContainmentError } from './contracts.js';

export function validateSystemdHelperWorkingDirectory(directory: string | undefined): asserts directory is string {
  if (!directory || !path.isAbsolute(directory) || path.resolve(directory) !== directory
    || realpathSync(directory) !== directory) throw invalid();
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.geteuid?.()
    || (metadata.mode & 0o077) !== 0 || readdirSync(directory).length !== 0) throw invalid();
}

function invalid(): SystemdContainmentError { return new SystemdContainmentError('NODE_CONTAINMENT_UNAVAILABLE'); }
