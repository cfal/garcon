import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type { ShellFamily } from './catalog.js';

export function parseSubmission(submission: string): { source: string; format: 'plain' | 'markdown' } {
  const prefix = /^\/(?:markdown|md)(?:[ \t]|\r?\n|$)/.exec(submission);
  const source = prefix ? submission.slice(prefix[0].length) : submission;
  if (!source.trim() || source.includes('\0')) {
    throw new AgentIntegrationError('INVALID_SETTINGS', 'A non-empty shell command without NUL bytes is required.', false);
  }
  return { source, format: prefix ? 'markdown' : 'plain' };
}

// Only private generated paths enter the bootstrap; submitted source is never interpolated.
export function commandFooter(family: ShellFamily, resultPath: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  if (family === 'fish') {
    const fishQuote = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
    return `set -l __garcon_status $status\nbuiltin pwd -P > ${fishQuote(resultPath)}\nexit $__garcon_status`;
  }
  if (family === 'pwsh') {
    const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return `$__garcon_ok = $?\n$__garcon_status = if ($__garcon_ok) { 0 } elseif ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 }\n$__garcon_location = Get-Location\nif ($__garcon_location.Provider.Name -eq 'FileSystem') { [System.IO.File]::WriteAllText(${psQuote(resultPath)}, $__garcon_location.ProviderPath + "\u0060n", [System.Text.UTF8Encoding]::new($false)) }\nexit $__garcon_status`;
  }
  return `__garcon_status=$?\ncommand pwd -P > ${quote(resultPath)}\nexit "$__garcon_status"`;
}

export const POWERSHELL_ENTRY = 'Set-Location -LiteralPath $args[0] -ErrorAction Stop\n. $args[1]\nexit $LASTEXITCODE\n';

export function shellInvocation(family: ShellFamily, sourcePath: string, cwd: string, entryPath: string): string[] {
  if (family === 'pwsh') return ['-NoLogo', '-File', entryPath, cwd, sourcePath];
  if (family === 'fish') return ['-i', '-c', 'status job-control none; builtin cd $argv[2]; or exit $status; source $argv[1]', sourcePath, cwd];
  const cd = family === 'sh' ? 'command cd' : 'builtin cd';
  return ['-i', '-c', `set +m; ${cd} -P -- "$2" || exit $?; . "$1"`, 'garcon', sourcePath, cwd];
}
