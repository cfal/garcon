import { promises as fs } from 'fs';
import path from 'path';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type { CodexConfig } from '../../config.js';
import { resolveCodexCli, type ResolvedCodexCli } from './app-server/cli.js';

export interface CodexAuthStatus {
  authenticated: boolean;
  canReauth: boolean;
  label: string;
  kind: 'api-key' | 'chatgpt' | 'external' | 'unknown' | 'none';
}

export interface CodexAuthStatusResolver {
  current(signal?: AbortSignal): Promise<CodexAuthStatus>;
  refresh(signal?: AbortSignal): Promise<CodexAuthStatus>;
  invalidate(): void;
}

interface CodexAuthStatusOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface CodexAuthStatusResolverOptions {
  readonly probeTimeoutMs?: number;
}

const CODEX_AUTH_STATUS_TIMEOUT_MS = 10_000;
const CODEX_AUTH_STATUS_ERROR_OUTPUT_LIMIT = 1_000;

export function buildCodexLoginStatusCommand(
  resolved: ResolvedCodexCli,
  runtime: { readonly platform: NodeJS.Platform; readonly executable: string } = {
    platform: process.platform,
    executable: process.execPath,
  },
): string[] {
  return resolved.source === 'bundled' && runtime.platform !== 'win32'
    ? [runtime.executable, resolved.command, 'login', 'status']
    : [resolved.command, 'login', 'status'];
}

export function createCodexAuthStatusResolver(
  config: CodexConfig,
  options: CodexAuthStatusResolverOptions = {},
): CodexAuthStatusResolver {
  let cached: CodexAuthStatus | null = null;
  let generation = 0;
  const load = async (signal: AbortSignal | undefined, expectedGeneration: number) => {
    const status = await getCodexAuthStatus(config, {
      signal,
      timeoutMs: options.probeTimeoutMs ?? CODEX_AUTH_STATUS_TIMEOUT_MS,
    });
    if (generation === expectedGeneration) cached = status;
    return status;
  };
  return {
    current: (signal) => {
      signal?.throwIfAborted();
      return cached ? Promise.resolve(cached) : load(signal, generation);
    },
    refresh: (signal) => {
      cached = null;
      generation += 1;
      return load(signal, generation);
    },
    invalidate: () => {
      cached = null;
      generation += 1;
    },
  };
}

interface CodexAuthFile {
  tokens?: {
    id_token?: unknown;
  };
}

interface CodexIdTokenPayload {
  email?: unknown;
  user?: unknown;
}

async function responseText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream ? new Response(stream).text() : '';
}

async function runCodexLoginStatus(
  config: CodexConfig,
  signal: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
  // Uses the CLI itself so Garcon follows CODEX_HOME and keyring-backed auth storage.
  await fs.mkdir(config.home(), { recursive: true });
  signal.throwIfAborted();
  const env = effectiveCodexEnvironment(config);
  const resolved = await resolveCodexCli({ env });
  signal.throwIfAborted();
  const proc = Bun.spawn(buildCodexLoginStatusCommand(resolved), {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
    signal,
  });

  const abort = () => {
    if (!proc.killed) proc.kill();
  };
  signal.addEventListener('abort', abort, { once: true });

  try {
    const [stdout, stderr, exitCode] = await waitForAbort(Promise.all([
      responseText(proc.stdout),
      responseText(proc.stderr),
      proc.exited,
    ]), signal);

    return {
      exitCode,
      output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n'),
    };
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function effectiveCodexEnvironment(config: CodexConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const apiKey = config.openAiApiKey();
  const baseUrl = config.openAiBaseUrl();
  const codexApiKey = config.codexApiKey();
  return {
    ...env,
    ...(codexApiKey ? { CODEX_API_KEY: codexApiKey } : {}),
    ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
    ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
    CODEX_HOME: config.home(),
  };
}

function parseAuthFile(raw: string): CodexAuthFile {
  const parsed: unknown = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as CodexAuthFile
    : {};
}

function parseIdTokenPayload(token: string): CodexIdTokenPayload {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return {};
  const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as CodexIdTokenPayload
    : {};
}

async function readCodexAuthLabel(config: CodexConfig, signal: AbortSignal): Promise<string> {
  try {
    const authPath = path.join(config.home(), 'auth.json');
    const content = await fs.readFile(authPath, { encoding: 'utf8', signal });
    const auth = parseAuthFile(content);
    const token = auth.tokens?.id_token;
    if (typeof token !== 'string' || !token) {
      return '';
    }

    const payload = parseIdTokenPayload(token);
    if (typeof payload.email === 'string') return payload.email;
    if (typeof payload.user === 'string') return payload.user;
    return '';
  } catch {
    return '';
  }
}

export async function getCodexAuthStatus(
  config: CodexConfig,
  options: CodexAuthStatusOptions = {},
): Promise<CodexAuthStatus> {
  return withAuthStatusControl(options, (signal) => resolveCodexAuthStatus(config, signal));
}

export async function resolveCodexExecAuthStatus(
  config: CodexConfig,
  resolveStoredAuthStatus: (signal?: AbortSignal) => Promise<CodexAuthStatus>,
  signal?: AbortSignal,
): Promise<CodexAuthStatus> {
  signal?.throwIfAborted();
  if (config.codexApiKey()) {
    return { authenticated: true, canReauth: false, label: '', kind: 'api-key' };
  }
  return resolveStoredAuthStatus(signal);
}

async function resolveCodexAuthStatus(
  config: CodexConfig,
  signal: AbortSignal,
): Promise<CodexAuthStatus> {
  if (config.openAiBaseUrl()) {
    return { authenticated: true, canReauth: false, label: '', kind: 'external' };
  }

  const configuredApiKey = config.openAiApiKey();
  try {
    const { exitCode, output } = await runCodexLoginStatus(config, signal);
    if (exitCode !== 0) {
      if (output.toLowerCase().includes('not logged in')) {
        return configuredApiKey
          ? { authenticated: true, canReauth: false, label: '', kind: 'api-key' }
          : { authenticated: false, canReauth: true, label: '', kind: 'none' };
      }
      const detail = output.slice(0, CODEX_AUTH_STATUS_ERROR_OUTPUT_LIMIT);
      throw new AgentIntegrationError(
        'PROVIDER_FAILURE',
        `Codex login status exited with code ${exitCode}${detail ? `: ${detail}` : '.'}`,
        true,
      );
    }

    const normalizedOutput = output.toLowerCase();
    if (normalizedOutput.includes('logged in using an api key')) {
      return { authenticated: true, canReauth: false, label: '', kind: 'api-key' };
    }

    if (normalizedOutput.includes('logged in using chatgpt')) {
      return {
        authenticated: true,
        canReauth: true,
        label: await readCodexAuthLabel(config, signal),
        kind: 'chatgpt',
      };
    }

    if (configuredApiKey) {
      return { authenticated: true, canReauth: false, label: '', kind: 'api-key' };
    }

    return {
      authenticated: true,
      canReauth: true,
      label: await readCodexAuthLabel(config, signal),
      kind: 'unknown',
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AgentIntegrationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentIntegrationError(
      'PROVIDER_FAILURE',
      `Codex login status check failed: ${message}`,
      true,
    );
  }
}

async function withAuthStatusControl<T>(
  options: CodexAuthStatusOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();

  const timeoutMs = options.timeoutMs ?? CODEX_AUTH_STATUS_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(
    new AgentIntegrationError(
      'TIMEOUT',
      `Codex authentication check timed out after ${timeoutMs}ms.`,
      true,
    ),
  ), timeoutMs);
  timeout.unref?.();

  try {
    controller.signal.throwIfAborted();
    return await waitForAbort(operation(controller.signal), controller.signal);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let removeAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    removeAbort();
  }
}
