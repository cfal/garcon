import { parse } from 'shell-quote';

const UNIX_SHELLS = new Set(['bash', 'sh', 'zsh']);
const POWERSHELL_SHELLS = new Set(['powershell', 'pwsh']);
const VARIABLE_REFERENCE = Object.freeze({});

export function normalizeCodexCommandDisplay(command: string): string {
  if (!hasBalancedPosixQuoting(command)) return command;

  try {
    const parsed = parse(command, () => VARIABLE_REFERENCE);
    if (!parsed.every((token): token is string => typeof token === 'string')) return command;
    return unwrapCodexShellCommand(parsed) ?? command;
  } catch {
    return command;
  }
}

function unwrapCodexShellCommand(argv: string[]): string | undefined {
  // Mirrors Codex's generated shell argv shapes: https://github.com/openai/codex/blob/rust-v0.144.6/codex-rs/core/src/shell.rs#L22-L48
  const shell = executableName(argv[0]);

  if (
    argv.length === 3
    && UNIX_SHELLS.has(shell)
    && (argv[1] === '-lc' || argv[1] === '-c')
  ) {
    return argv[2];
  }

  if (
    argv.length === 3
    && POWERSHELL_SHELLS.has(shell)
    && argv[1]?.toLowerCase() === '-command'
  ) {
    return argv[2];
  }

  if (
    argv.length === 4
    && POWERSHELL_SHELLS.has(shell)
    && argv[1]?.toLowerCase() === '-noprofile'
    && argv[2]?.toLowerCase() === '-command'
  ) {
    return argv[3];
  }

  if (
    argv.length === 3
    && shell === 'cmd'
    && argv[1]?.toLowerCase() === '/c'
  ) {
    return argv[2];
  }

  return undefined;
}

function executableName(executable: string | undefined): string {
  const basename = executable?.split(/[\\/]/u).at(-1)?.toLowerCase() ?? '';
  return basename.endsWith('.exe') ? basename.slice(0, -4) : basename;
}

function hasBalancedPosixQuoting(command: string): boolean {
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }

    if (character === '\\') {
      if (index + 1 >= command.length) return false;
      index += 1;
      continue;
    }

    if (quote === '"') {
      if (character === '"') quote = undefined;
      continue;
    }

    if (character === "'" || character === '"') quote = character;
  }

  return quote === undefined;
}
