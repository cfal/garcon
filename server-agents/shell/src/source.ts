import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type { ShellFamily } from './catalog.js';

export function parseSubmission(submission: string): { source: string; format: 'plain' | 'markdown' } {
  const prefix = /^\/(?:markdown|md)(?:[ \t]|\r?\n|$)/.exec(submission);
  const source = prefix ? submission.slice(prefix[0].length) : submission;
  if (!source.trim() || source.includes('\0') || !source.isWellFormed()) {
    throw new AgentIntegrationError('INVALID_SETTINGS', 'A non-empty, well-formed Unicode shell command without NUL bytes is required.', false);
  }
  return { source, format: prefix ? 'markdown' : 'plain' };
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandFooter(family: ShellFamily, resultPath: string): string {
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
    `command pwd -P > ${quotePosix(resultPath)}`,
    '(exit "$__garcon_status")',
  ].join('\n');
}

export function shellInvocation(family: ShellFamily, sourcePath: string, cwd: string, resultPath: string): string[] {
  const footer = commandFooter(family, resultPath);
  if (family === 'fish') return ['-i', '-c', `status job-control none; builtin cd $argv[2]; or exit $status; source $argv[1]\n${footer}`, sourcePath, cwd];
  const cd = family === 'sh' ? 'command cd' : 'builtin cd';
  // Dash otherwise returns to interactive stdin after a sourced syntax error.
  const noninteractive = family === 'sh' ? '(set +i) 2>/dev/null && set +i; ' : '';
  return ['-i', '-c', `${noninteractive}set +m; ${cd} -P -- ${quotePosix(cwd)} || exit $?; . ${quotePosix(sourcePath)}\n${footer}`];
}
