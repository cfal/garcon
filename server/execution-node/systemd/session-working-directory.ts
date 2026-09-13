import { lstat, mkdir, readdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { SystemdContainmentError } from './contracts.js';

export async function createNodeSessionWorkingDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  await privateDirectory(directory);
}

/** Runs only after exact unit cleanup; unexpected contents preserve the marker and replacement fence. */
export async function removeNodeSessionWorkingDirectory(directory: string): Promise<void> {
  try { await privateDirectory(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const names = await readdir(directory);
  for (const name of names) {
    if (!name.startsWith('instance-') || !isExecutionIdentity(name.slice('instance-'.length))) throw invalid();
    const child = path.join(directory, name);
    await privateDirectory(child);
    if ((await readdir(child)).length !== 0) throw invalid();
  }
  for (const name of names) await rmdir(path.join(directory, name));
  await rmdir(directory);
}

async function privateDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.geteuid?.() || (metadata.mode & 0o077) !== 0) throw invalid();
}

function invalid(): SystemdContainmentError { return new SystemdContainmentError('NODE_CONTAINMENT_MISMATCH'); }
