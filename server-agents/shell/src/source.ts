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

function commandFooter(family: ShellFamily, resultPath: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  if (family === 'fish') {
    const fishQuote = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
    return [
      'set -l __garcon_status $status',
      `builtin pwd -P > ${fishQuote(resultPath)}`,
      'exit $__garcon_status',
    ].join('\n');
  }
  return [
    '__garcon_status=$?',
    `command pwd -P > ${quote(resultPath)}`,
    '(exit "$__garcon_status")',
  ].join('\n');
}

export const POWERSHELL_ENTRY = [
  'param([string]$__garcon_initialCwd, [string]$__garcon_sourcePath, [string]$__garcon_resultPath)',
  'Set-Location -LiteralPath $__garcon_initialCwd -ErrorAction Stop',
  '$__garcon_previousError = if ($Error.Count) { $Error[0] } else { $null }',
  '$LASTEXITCODE = 0',
  'try {',
  '  . $__garcon_sourcePath',
  '  $__garcon_ok = $?',
  '} catch {',
  '  $__garcon_ok = $false',
  '  Write-Error -ErrorRecord $_ -ErrorAction Continue',
  '}',
  '$__garcon_nativeFailed = $LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0',
  '$__garcon_currentError = if ($Error.Count) { $Error[0] } else { $null }',
  '$__garcon_newError = -not [object]::ReferenceEquals($__garcon_previousError, $__garcon_currentError)',
  '$__garcon_status = if ($__garcon_nativeFailed) { $LASTEXITCODE } elseif (-not $__garcon_ok -or $__garcon_newError) { 1 } else { 0 }',
  '$__garcon_location = Get-Location',
  'if ($__garcon_location.Provider.Name -eq \'FileSystem\') {',
  '  [System.IO.File]::WriteAllText($__garcon_resultPath, $__garcon_location.ProviderPath + "`n", [System.Text.UTF8Encoding]::new($false))',
  '}',
  'exit $__garcon_status',
  '',
].join('\n');

export function shellInvocation(family: ShellFamily, sourcePath: string, cwd: string, entryPath: string, resultPath: string): string[] {
  if (family === 'pwsh') return ['-NoLogo', '-File', entryPath, cwd, sourcePath, resultPath];
  const footer = commandFooter(family, resultPath);
  if (family === 'fish') return ['-i', '-c', `status job-control none; builtin cd $argv[2]; or exit $status; source $argv[1]\n${footer}`, sourcePath, cwd];
  const cd = family === 'sh' ? 'command cd' : 'builtin cd';
  // Dash otherwise returns to interactive stdin after a sourced syntax error.
  const noninteractive = family === 'sh' ? '(set +i) 2>/dev/null && set +i; ' : '';
  return ['-i', '-c', `${noninteractive}set +m; ${cd} -P -- "$2" || exit $?; . "$1"\n${footer}`, 'garcon', sourcePath, cwd];
}
