import { stat } from 'node:fs/promises';

export async function assertPrivateFile(filePath: string): Promise<void> {
  try {
    const details = await stat(filePath);
    if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
      throw new Error('Credential file must be accessible only to its OS account');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
