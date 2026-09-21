import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasNodeErrorCode } from '../lib/errors.js';

const STAGING_ROOT = path.join(os.homedir(), '.cache', 'garcon', 'file-transfers');
const HOST_PREFIX = `transfer-v1-${createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16)}-`;

export async function cleanupAbandonedFileStaging(root = STAGING_ROOT): Promise<void> {
  let handle;
  try { handle = await fs.opendir(root); }
  catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  for await (const entry of handle) {
    if (!entry.isDirectory() || !entry.name.startsWith(HOST_PREFIX)) continue;
    const owner = /^([1-9]\d*)-[a-zA-Z0-9]{6}$/.exec(entry.name.slice(HOST_PREFIX.length));
    if (!owner) continue;
    const pid = Number(owner[1]);
    if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) continue;
    try { process.kill(pid, 0); }
    catch (error) {
      // Only definite absence permits deletion; PID reuse and permission failures retain staging.
      if (hasNodeErrorCode(error, 'ESRCH')) await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
    }
  }
}

export async function createFileStaging(root = STAGING_ROOT): Promise<string> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await cleanupAbandonedFileStaging(root);
  // Atomic directory creation records its live owner before any uploaded bytes exist.
  return fs.mkdtemp(path.join(root, `${HOST_PREFIX}${process.pid}-`));
}
