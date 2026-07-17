import { createHash } from 'crypto';
import { promises as fs, type BigIntStats } from 'fs';
import { DomainError } from '../lib/domain-error.js';
import { hasNodeErrorCode } from '../lib/errors.js';
import type { FileRevision } from '../../common/file-contracts.ts';

export const FILE_CHANGED_DURING_READ = 'FILE_CHANGED_DURING_READ';
export const FILE_PATH_MUST_IDENTIFY_FILE = 'FILE_PATH_MUST_IDENTIFY_FILE';

export class FileChangedDuringReadError extends DomainError {
  constructor() {
    super(
      FILE_CHANGED_DURING_READ,
      'File changed repeatedly while it was being read',
      409,
      true,
    );
    this.name = 'FileChangedDuringReadError';
  }
}

export class FilePathMustIdentifyFileError extends DomainError {
  constructor() {
    super(
      FILE_PATH_MUST_IDENTIFY_FILE,
      'File path must identify a file',
      400,
      false,
    );
    this.name = 'FilePathMustIdentifyFileError';
  }
}

interface VersionedReadHandle {
  stat(options: { bigint: true }): Promise<BigIntStats>;
  readFile(): Promise<Buffer>;
  close(): Promise<void>;
}

interface VersionedReadOptions {
  maxAttempts?: number;
  openFile?: (filePath: string) => Promise<VersionedReadHandle>;
}

export function revisionFromStat(stat: BigIntStats): FileRevision {
  const source = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map(String)
    .join(':');
  const digest = createHash('sha256').update(source).digest('base64url');
  return `v1:${digest}`;
}

function revisionForFileStat(stat: BigIntStats): FileRevision {
  if (!stat.isFile()) throw new FilePathMustIdentifyFileError();
  return revisionFromStat(stat);
}

export async function getFileRevision(
  filePath: string,
): Promise<FileRevision> {
  return revisionForFileStat(await fs.stat(filePath, { bigint: true }));
}

export async function getFileRevisionOrMissing(
  filePath: string,
): Promise<FileRevision | null> {
  try {
    return await getFileRevision(filePath);
  } catch (error) {
    if (
      hasNodeErrorCode(error, 'ENOENT') ||
      hasNodeErrorCode(error, 'ENOTDIR')
    ) {
      return null;
    }
    throw error;
  }
}

export async function readVersionedFile(
  filePath: string,
  options: VersionedReadOptions = {},
): Promise<{ bytes: Buffer; revision: FileRevision }> {
  const maxAttempts = options.maxAttempts ?? 3;
  const openFile =
    options.openFile ??
    (async (targetPath: string): Promise<VersionedReadHandle> =>
      fs.open(targetPath, 'r'));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const handle = await openFile(filePath);
    try {
      const before = revisionForFileStat(await handle.stat({ bigint: true }));
      const bytes = await handle.readFile();
      const after = revisionForFileStat(await handle.stat({ bigint: true }));
      if (before === after) return { bytes, revision: after };
    } finally {
      await handle.close();
    }
  }

  throw new FileChangedDuringReadError();
}
