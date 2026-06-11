import { getAnthropicApiKey, getAnthropicBaseUrl, getClaudeBinary } from "../../config.js";

async function runClaudeAuthStatus() {
  // Uses the CLI itself so Garcon follows CLAUDE_CONFIG_DIR and other auth storage rules.
  const proc = Bun.spawn([getClaudeBinary(), 'auth', 'status'], {
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

function parseClaudeAuthStatus(output) {
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    return null;
  }

  try {
    return JSON.parse(output.slice(jsonStart, jsonEnd + 1));
  } catch {
    return null;
  }
}

export async function getClaudeAuthStatus() {
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
