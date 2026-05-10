import { getPiBinary } from '../config.js';
import { parsePiListModelsOutput } from './pi-models.js';

export function hasPiModelRows(output: string): boolean {
  return parsePiListModelsOutput(output).length > 0;
}

export async function getPiAuthStatus(): Promise<{
  authenticated: boolean;
  canReauth: false;
  label: string;
}> {
  try {
    const proc = Bun.spawn([getPiBinary(), '--list-models'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      return {
        authenticated: false,
        canReauth: false,
        label: (stderr || stdout).trim(),
      };
    }

    return {
      authenticated: hasPiModelRows(stdout),
      canReauth: false,
      label: '',
    };
  } catch {
    return { authenticated: false, canReauth: false, label: '' };
  }
}
