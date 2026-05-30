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

  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(tempPath, payload, options.mode ? { mode: options.mode } : 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
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
