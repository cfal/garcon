import { promises as fs } from 'fs';
import path from 'path';
import type { CodexConfig } from '../../config.js';

interface AgentAuthStatus {
  authenticated: boolean;
  canReauth: boolean;
  label: string;
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
): Promise<{ exitCode: number; output: string }> {
  // Uses the CLI itself so Garcon follows CODEX_HOME and keyring-backed auth storage.
  const proc = Bun.spawn(['codex', 'login', 'status'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CODEX_HOME: config.home() },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    responseText(proc.stdout),
    responseText(proc.stderr),
    proc.exited,
  ]);

  return {
    exitCode,
    output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n'),
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

async function readCodexAuthLabel(config: CodexConfig): Promise<string> {
  try {
    const authPath = path.join(config.home(), 'auth.json');
    const content = await fs.readFile(authPath, 'utf8');
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

export async function getCodexAuthStatus(config: CodexConfig): Promise<AgentAuthStatus> {
  if (config.openAiBaseUrl()) {
    return { authenticated: true, canReauth: false, label: '' };
  }
  if (config.openAiApiKey()) {
    return { authenticated: true, canReauth: false, label: '' };
  }

  try {
    const { exitCode, output } = await runCodexLoginStatus(config);
    if (exitCode !== 0) {
      return { authenticated: false, canReauth: true, label: '' };
    }

    const normalizedOutput = output.toLowerCase();
    if (normalizedOutput.includes('logged in using an api key')) {
      return { authenticated: true, canReauth: false, label: '' };
    }

    if (normalizedOutput.includes('logged in using chatgpt')) {
      return {
        authenticated: true,
        canReauth: true,
        label: await readCodexAuthLabel(config),
      };
    }

    return {
      authenticated: true,
      canReauth: true,
      label: await readCodexAuthLabel(config),
    };
  } catch {
    return { authenticated: false, canReauth: true, label: '' };
  }
}
