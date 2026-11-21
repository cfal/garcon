export interface ResolvedCodexCli {
  command: string;
  source: 'env' | 'path';
}

export function resolveCodexCli(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedCodexCli {
  const command = env.GARCON_CODEX_CLI?.trim();
  return command
    ? { command, source: 'env' }
    : { command: platform === 'win32' ? 'codex.exe' : 'codex', source: 'path' };
}

// Codex reports its own version, not Garcon's, in the first token of initialize.userAgent.
export function assertCompatibleCodex(userAgent: string): void {
  const version = /^[^\s/]+\/(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/.exec(userAgent);
  if (!version || (Number(version[1]) === 0 && Number(version[2]) < 171)) {
    throw new Error('Codex app-server requires Codex CLI 0.171.0 or newer. Upgrade it on this executor or set GARCON_CODEX_CLI.');
  }
}
