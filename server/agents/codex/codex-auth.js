import { promises as fs } from 'fs';
import path from 'path';
import { getCodexHome, getOpenAiApiKey, getOpenAiBaseUrl } from '../../config.js';

async function runCodexLoginStatus() {
  // Uses the CLI itself so Garcon follows CODEX_HOME and keyring-backed auth storage.
  const proc = Bun.spawn(['codex', 'login', 'status'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    exitCode,
    output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n'),
  };
}

async function readCodexAuthLabel() {
  try {
    const authPath = path.join(getCodexHome(), 'auth.json');
    const content = await fs.readFile(authPath, 'utf8');
    const auth = JSON.parse(content);
    const tokens = auth.tokens || {};
    if (!tokens.id_token) {
      return '';
    }

    const parts = tokens.id_token.split('.');
    if (parts.length < 2) {
      return '';
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.email || payload.user || '';
  } catch {
    return '';
  }
}

export async function getCodexAuthStatus() {
  if (getOpenAiBaseUrl()) {
    return { authenticated: true, canReauth: false, label: '' };
  }
  if (getOpenAiApiKey()) {
    return { authenticated: true, canReauth: false, label: '' };
  }

  try {
    const { exitCode, output } = await runCodexLoginStatus();
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
        label: await readCodexAuthLabel(),
      };
    }

    return {
      authenticated: true,
      canReauth: true,
      label: await readCodexAuthLabel(),
    };
  } catch {
    return { authenticated: false, canReauth: true, label: '' };
  }
}
