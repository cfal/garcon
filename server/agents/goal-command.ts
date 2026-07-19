const CODEX_GOAL_COMMAND_RE = /^\s*\/goal(?:\s+([\s\S]*))?$/i;

export type CodexGoalCommand =
  | { kind: 'status' }
  | { kind: 'set'; objective: string }
  | { kind: 'replace'; objective: string }
  | { kind: 'edit'; objective: string | null }
  | { kind: 'clear' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'unsupported'; subcommand: string };

export function parseCodexGoalCommand(command: string): CodexGoalCommand | null {
  const match = CODEX_GOAL_COMMAND_RE.exec(command);
  if (!match) return null;
  const argument = (match[1] ?? '').trim();
  if (!argument) return { kind: 'status' };

  const lower = argument.toLowerCase();
  if (lower === 'clear') return { kind: 'clear' };
  if (lower === 'pause') return { kind: 'pause' };
  if (lower === 'resume') return { kind: 'resume' };
  if (lower === 'edit') return { kind: 'edit', objective: null };
  if (lower.startsWith('edit ')) return { kind: 'edit', objective: argument.slice(5).trim() || null };
  if (lower === 'replace') return { kind: 'unsupported', subcommand: lower };
  if (lower.startsWith('replace ')) return { kind: 'replace', objective: argument.slice(8).trim() };
  return { kind: 'set', objective: argument };
}
