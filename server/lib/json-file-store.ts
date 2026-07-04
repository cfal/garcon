import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

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

async function syncDirectory(dir: string): Promise<void> {
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
