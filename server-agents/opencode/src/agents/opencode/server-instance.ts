import { spawn, type ChildProcess } from 'node:child_process';
import type { OpenCodeInstance } from './instance-lifecycle.js';
import { materializeOpenCodeOperationIdentityPlugin } from './operation-identity-plugin-host.js';

export function buildOpenCodeServerEnv(
  baseEnv: Record<string, string | undefined> = process.env,
  operationIdentityPluginUrl?: string,
): Record<string, string | undefined> {
  const { OPENCODE_PURE: _pureMode, ...serverEnv } = baseEnv;
  return {
    ...serverEnv,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(
      operationIdentityPluginUrl ? { plugin: [operationIdentityPluginUrl] } : {},
    ),
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
  port: number;
  signal: AbortSignal;
}): Promise<OpenCodeInstance> {
  const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
  input.signal.throwIfAborted();
  const operationIdentityPlugin = await materializeOpenCodeOperationIdentityPlugin();
  let proc: ChildProcess;
  try {
    input.signal.throwIfAborted();
    proc = spawn('opencode', ['serve', '--hostname=127.0.0.1', `--port=${input.port}`], {
      env: buildOpenCodeServerEnv(process.env, operationIdentityPlugin.url),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    operationIdentityPlugin.close();
    throw error;
  }
  let resourcesClosed = false;
  const closeResources = () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    stopOpenCodeProcess(proc);
    operationIdentityPlugin.close();
  };
  proc.once('exit', () => {
    operationIdentityPlugin.close();
  });

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
