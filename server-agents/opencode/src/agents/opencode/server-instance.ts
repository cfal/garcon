import { spawn, type ChildProcess } from 'node:child_process';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import type { OpenCodeInstance, OpenCodeServerTermination } from './instance-lifecycle.js';
import { resolveSessionIdentityPluginUrl } from './session-identity-plugin.js';

function pluginSpecifier(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (
    Array.isArray(entry)
    && entry.length === 2
    && typeof entry[0] === 'string'
    && entry[1] !== null
    && typeof entry[1] === 'object'
    && !Array.isArray(entry[1])
  ) {
    return entry[0];
  }
  return null;
}

export function mergeOpenCodeConfigContent(
  inheritedContent: string | undefined,
  sessionIdentityPluginUrl: string,
): string {
  let inherited: unknown = {};
  if (inheritedContent !== undefined && inheritedContent.trim() !== '') {
    const errors: ParseError[] = [];
    inherited = parse(inheritedContent, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0) {
      const first = errors[0]!;
      throw new Error(
        'Invalid inherited OPENCODE_CONFIG_CONTENT'
        + ` at offset ${first.offset}: ${printParseErrorCode(first.error)}.`,
      );
    }
  }
  if (inherited === null || typeof inherited !== 'object' || Array.isArray(inherited)) {
    throw new Error('Invalid inherited OPENCODE_CONFIG_CONTENT: expected a JSONC object.');
  }

  const config = inherited as Record<string, unknown>;
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) {
    throw new Error('Invalid inherited OPENCODE_CONFIG_CONTENT: "plugin" must be an array.');
  }
  const plugins: unknown[] = config.plugin ?? [];
  const invalidPluginIndex = plugins.findIndex((entry) => pluginSpecifier(entry) === null);
  if (invalidPluginIndex >= 0) {
    throw new Error(
      'Invalid inherited OPENCODE_CONFIG_CONTENT:'
      + ` "plugin[${invalidPluginIndex}]" must be a string or [specifier, options] tuple.`,
    );
  }
  const sessionIdentityPluginEntry = plugins.findLast(
    (entry) => pluginSpecifier(entry) === sessionIdentityPluginUrl,
  ) ?? sessionIdentityPluginUrl;
  return JSON.stringify({
    ...config,
    plugin: [
      ...plugins.filter((entry) => pluginSpecifier(entry) !== sessionIdentityPluginUrl),
      sessionIdentityPluginEntry,
    ],
  });
}

export function buildOpenCodeServerEnv(
  baseEnv: Record<string, string | undefined> = process.env,
  sessionIdentityPluginUrl: string = resolveSessionIdentityPluginUrl(),
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const serverEnv = { ...baseEnv };
  let inheritedConfigContent = serverEnv.OPENCODE_CONFIG_CONTENT;
  for (const key of Object.keys(serverEnv)) {
    const normalizedKey = platform === 'win32' ? key.toUpperCase() : key;
    if (normalizedKey === 'OPENCODE_CONFIG_CONTENT') {
      inheritedConfigContent ??= serverEnv[key];
      delete serverEnv[key];
    } else if (normalizedKey === 'OPENCODE_PURE' || normalizedKey === 'OPENCODE_SESSION_ID') {
      delete serverEnv[key];
    }
  }
  return {
    ...serverEnv,
    OPENCODE_CONFIG_CONTENT: mergeOpenCodeConfigContent(
      inheritedConfigContent,
      sessionIdentityPluginUrl,
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

export interface OpenCodeProcessLifetime {
  readonly termination: Promise<OpenCodeServerTermination>;
  // True once the process reported exit or error, distinguishing a deliberate
  // kill of a live process from cleanup after an observed death.
  exitObserved(): boolean;
}

// Lifetime observers, resolved once and never rejected: unlike startup
// handlers, these survive readiness so the runtime learns about post-readiness
// death. The error observer stays registered for the process lifetime because
// a failed escalation kill can emit 'error' after an earlier one consumed a
// once listener; promise resolution is one-shot, so repeated events settle
// only the first outcome.
export function trackOpenCodeProcessLifetime(
  proc: Pick<ChildProcess, 'once' | 'on'>,
): OpenCodeProcessLifetime {
  let settleTermination!: (termination: OpenCodeServerTermination) => void;
  let exitObserved = false;
  const termination = new Promise<OpenCodeServerTermination>((resolve) => {
    settleTermination = resolve;
  });
  proc.once('exit', (code, signal) => {
    exitObserved = true;
    settleTermination({ kind: 'exit', code, signal });
  });
  proc.on('error', (error) => {
    exitObserved = true;
    settleTermination({ kind: 'error', error });
  });
  return {
    termination,
    exitObserved: () => exitObserved,
  };
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
  const lifetime = trackOpenCodeProcessLifetime(proc);
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
    server: {
      close: closeResources,
      termination: lifetime.termination,
      exitObserved: lifetime.exitObserved,
    },
  };
}
