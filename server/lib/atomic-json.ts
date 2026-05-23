import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.${process.pid}.${crypto.randomUUID()}.tmp`);

  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}
