import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from './log.js';

const logger = createLogger('json-file-store');
export const QUARANTINE_INFIX = '.corrupt-';

export class CorruptStateFileError extends Error {
  readonly filePath: string;
  readonly quarantinePath: string | null;

  constructor(filePath: string, quarantinePath: string | null, options?: ErrorOptions) {
    const basename = path.basename(filePath);
    const message = quarantinePath
      ? `State file ${basename} is corrupt. Restore or remove its quarantine before starting.`
      : `State file ${basename} is corrupt and could not be quarantined.`;
    super(message, options);
    this.name = 'CorruptStateFileError';
    this.filePath = filePath;
    this.quarantinePath = quarantinePath;
  }
}

export async function readJsonStateFile<T>(options: {
  filePath: string;
  empty(): T;
  normalize(value: unknown): T;
}): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(options.filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Preserves the tombstone so a restart cannot treat quarantined state as a fresh install.
    const quarantinePath = await newestQuarantinePath(options.filePath);
    if (quarantinePath) {
      throw new CorruptStateFileError(options.filePath, quarantinePath, { cause: error });
    }
    return options.empty();
  }

  try {
    return options.normalize(JSON.parse(raw));
  } catch (error) {
    return quarantineStateFile(options.filePath, error);
  }
}

async function newestQuarantinePath(filePath: string): Promise<string | null> {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}${QUARANTINE_INFIX}`;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const newest = entries.filter((entry) => entry.startsWith(prefix)).sort().at(-1);
  return newest ? path.join(dir, newest) : null;
}

async function quarantineStateFile(filePath: string, cause: unknown): Promise<never> {
  const dir = path.dirname(filePath);
  const compactTimestamp = new Date().toISOString().replace(/[-:.]/g, '');
  const suffix = crypto.randomUUID().slice(0, 8);
  const quarantinePath = `${filePath}${QUARANTINE_INFIX}${compactTimestamp}-${suffix}`;
  try {
    await fs.rename(filePath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      let existingQuarantine: string | null;
      try {
        existingQuarantine = await newestQuarantinePath(filePath);
      } catch (lookupError) {
        logger.error(`State file ${filePath} is corrupt and its quarantine could not be located.`, lookupError);
        throw new CorruptStateFileError(filePath, null, { cause: lookupError });
      }
      if (existingQuarantine) {
        throw new CorruptStateFileError(filePath, existingQuarantine, { cause: error });
      }
    }
    logger.error(`State file ${filePath} is corrupt and could not be quarantined.`, error);
    throw new CorruptStateFileError(filePath, null, { cause: error });
  }
  try {
    await syncDirectory(dir);
  } catch (error) {
    logger.error(`State file ${filePath} was quarantined to ${quarantinePath}, but the directory sync failed.`, error);
    throw new CorruptStateFileError(filePath, quarantinePath, { cause: error });
  }
  logger.error(
    `State file ${filePath} is corrupt and was quarantined to ${quarantinePath}. Restore or remove the quarantine before starting.`,
    cause,
  );
  throw new CorruptStateFileError(filePath, quarantinePath, { cause });
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: { mode?: number; trailingNewline?: boolean } = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const payload = JSON.stringify(value, null, 2) + (options.trailingNewline === false ? '' : '\n');
  let file: Awaited<ReturnType<typeof fs.open>> | null = null;

  await fs.mkdir(dir, { recursive: true });
  try {
    file = await fs.open(tempPath, 'w', options.mode);
    await file.writeFile(payload, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await fs.rename(tempPath, filePath);
    await syncDirectory(dir);
  } catch (error) {
    if (file) await file.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function syncDirectory(dir: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    directory = await fs.open(dir, 'r');
    await directory.sync();
  } catch (error) {
    if (isUnsupportedDirectorySyncError(error)) return;
    throw error;
  } finally {
    if (directory) await directory.close().catch(() => {});
  }
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EISDIR' || code === 'EINVAL' || code === 'EPERM' || code === 'ENOTSUP';
}

export class JsonFileStore<T> {
  constructor(private readonly options: {
    filePath: string;
    empty(): T;
    normalize(value: unknown): T;
    mode?: number;
  }) {}

  async read(): Promise<T> {
    try {
      const raw = await fs.readFile(this.options.filePath, 'utf8');
      return this.options.normalize(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.options.empty();
      }
      throw error;
    }
  }

  async write(value: T): Promise<void> {
    await writeJsonFileAtomic(this.options.filePath, value, {
      mode: this.options.mode,
    });
  }
}
