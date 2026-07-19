import { getAnthropicApiKey, getAnthropicBaseUrl, getClaudeBinary } from "../../config.js";

interface AgentAuthStatus {
  authenticated: boolean;
  canReauth: boolean;
  label: string;
}

interface ClaudeAuthStatusPayload {
  loggedIn?: unknown;
  authMethod?: unknown;
  email?: unknown;
}

async function responseText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream ? new Response(stream).text() : '';
}

async function runClaudeAuthStatus(): Promise<{ exitCode: number; output: string }> {
  // Uses the CLI itself so Garcon follows CLAUDE_CONFIG_DIR and other auth storage rules.
  const proc = Bun.spawn([getClaudeBinary(), 'auth', 'status'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
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

function parseClaudeAuthStatus(output: string): ClaudeAuthStatusPayload | null {
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(output.slice(jsonStart, jsonEnd + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ClaudeAuthStatusPayload
      : null;
  } catch {
    return null;
  }
}

export async function getClaudeAuthStatus(): Promise<AgentAuthStatus> {
  // bypass claude auth check if custom ANTHROPIC_BASE_URL is set
  if (getAnthropicBaseUrl()) {
    return { authenticated: true, canReauth: false, label: '' };
  }
  if (getAnthropicApiKey()) {
    return { authenticated: true, canReauth: false, label: '' };
  }

  try {
    const { exitCode, output } = await runClaudeAuthStatus();
    if (exitCode !== 0) {
      return { authenticated: false, canReauth: true, label: '' };
    }

    const status = parseClaudeAuthStatus(output);
    if (status?.loggedIn === true) {
      return {
        authenticated: true,
        canReauth: status.authMethod !== 'api_key',
        label: typeof status.email === 'string' ? status.email : '',
      };
    }

    return { authenticated: true, canReauth: true, label: '' };
  } catch {
    return { authenticated: false, canReauth: true, label: '' };
  }
}
