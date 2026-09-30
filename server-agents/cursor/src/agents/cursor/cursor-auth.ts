import type { CursorConfig } from '../../config.js';

async function runCursorStatus(config: CursorConfig): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const proc = Bun.spawn([config.binary(), 'status', '--format', 'json'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(5_000),
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(''),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(''),
    proc.exited.catch(() => null),
  ]);

  return { stdout, stderr, exitCode };
}

// A parse error's message can echo the output, so the error names the output instead.
function parseCursorStatus(stdout: string): Record<string, unknown> {
  try { return JSON.parse(stdout || '{}') as Record<string, unknown>; }
  catch { throw new Error('Cursor status output is not valid JSON.'); }
}

export async function getCursorAuthStatus(config: CursorConfig) {
  if (config.apiKey()) {
    return {
      authenticated: true,
      canReauth: false as const,
      label: 'CURSOR_API_KEY',
      source: 'environment' as const,
    };
  }

  try {
    const { stdout, stderr, exitCode } = await runCursorStatus(config);
    const body = parseCursorStatus(stdout);
    const authenticated = body.isAuthenticated === true
      || body.authenticated === true
      || body.status === 'authenticated';
    const label = typeof body.email === 'string' && body.email
      ? body.email
      : typeof body.message === 'string' && authenticated
        ? body.message
        : '';

    return {
      authenticated,
      canReauth: false as const,
      label,
      source: authenticated ? 'cli' as const : 'none' as const,
      detail: authenticated
        ? undefined
        : typeof body.message === 'string' ? body.message : (stderr || `Cursor status exited with code ${exitCode ?? 'unknown'}`).trim(),
    };
  } catch (error) {
    return {
      authenticated: false,
      canReauth: false as const,
      label: '',
      source: 'none' as const,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
