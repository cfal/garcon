import { spawn, type ChildProcess } from 'node:child_process';
import type { OpenCodeInstance } from './instance-lifecycle.js';

export function buildOpenCodeServerEnv(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const { OPENCODE_PURE: _pureMode, ...serverEnv } = baseEnv;
  return {
    ...serverEnv,
    OPENCODE_CONFIG_CONTENT: '{}',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
}

function stopOpenCodeProcess(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  proc.kill();
  proc.stdout?.destroy();
  proc.stderr?.destroy();

  const killTimer = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
    }
  }, 500);
  killTimer.unref?.();
  proc.once('exit', () => clearTimeout(killTimer));
}

export async function createOpenCodeInstance(input: {
  signal: AbortSignal;
}): Promise<OpenCodeInstance> {
  const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
  input.signal.throwIfAborted();
  // Port 0 delegates allocation to the OS; the resolved port arrives through
  // the readiness line parsed below, so collisions cannot fail startup.
  const proc = spawn('opencode', ['serve', '--hostname=127.0.0.1', '--port=0'], {
    env: buildOpenCodeServerEnv(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let resourcesClosed = false;
  const closeResources = () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    stopOpenCodeProcess(proc);
  };

  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    let resolved = false;

    const cleanup = () => {
      input.signal.removeEventListener('abort', abort);
      proc.off('exit', onExit);
      proc.off('error', onError);
      proc.stdout?.off('data', onStdout);
      proc.stderr?.off('data', onStderr);
    };

    const fail = (error: unknown) => {
      if (resolved) return;
      cleanup();
      closeResources();
      reject(error);
    };

    const abort = () => {
      fail(input.signal.reason ?? new Error('OpenCode startup aborted'));
    };

    const onStdout = (chunk: Buffer) => {
      if (resolved) return;
      output += chunk.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (!line.startsWith('opencode server listening')) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          fail(new Error(`Failed to parse OpenCode server URL from output: ${line}`));
          return;
        }
        resolved = true;
        cleanup();
        resolve(match[1]);
        return;
      }
    };

    const onStderr = (chunk: Buffer) => {
      output += chunk.toString();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = output.trim() ? `\nServer output: ${output.trim()}` : '';
      fail(new Error(`OpenCode server exited before startup with code ${code ?? signal}${detail}`));
    };

    const onError = (error: Error) => {
      fail(error);
    };

    input.signal.addEventListener('abort', abort, { once: true });
    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    proc.on('exit', onExit);
    proc.on('error', onError);

    if (input.signal.aborted) abort();
  });

  return {
    client: createOpencodeClient({ baseUrl: url }),
    baseUrl: url,
    server: { close: closeResources },
  };
}
