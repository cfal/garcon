import { isRecord } from './json.js';
import type { CommandOutputMessage } from './chat-types.js';

export interface CommandOutputContext {
  readonly executorId: string;
  readonly projectPath: string;
}

export function isCommandOutputData(value: unknown): value is Record<string, unknown> & Pick<CommandOutputMessage, 'commandId' | 'content' | 'offset' | 'channel' | 'format'> {
  return isRecord(value)
    && typeof value.commandId === 'string' && value.commandId.length > 0
    && typeof value.content === 'string'
    && typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0
    && (value.channel === 'stdout' || value.channel === 'stderr')
    && (value.format === 'plain' || value.format === 'markdown')
    && (value.channel !== 'stderr' || value.format === 'plain');
}

export type CommandWorkingDirectory =
  | { readonly kind: 'reported'; readonly path: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface CommandOutcome {
  readonly outcome: 'finished' | 'failed' | 'interrupted' | 'unknown';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly cwd: CommandWorkingDirectory;
  readonly capture: 'complete' | 'incomplete';
}

export function parseCommandOutputContext(value: unknown): CommandOutputContext | null {
  if (!isRecord(value) || typeof value.executorId !== 'string' || !value.executorId
    || typeof value.projectPath !== 'string' || !value.projectPath
    || value.projectPath.includes('\0')) return null;
  return { executorId: value.executorId, projectPath: value.projectPath };
}

export function parseCommandWorkingDirectory(value: unknown): CommandWorkingDirectory | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'reported' && typeof value.path === 'string' && value.path.startsWith('/')
    && value.path.length <= 65_536 && !value.path.includes('\0')) {
    return { kind: 'reported', path: value.path };
  }
  if (value.kind === 'unavailable' && typeof value.reason === 'string' && value.reason.length <= 4096) {
    return { kind: 'unavailable', reason: value.reason };
  }
  return null;
}

export function parseCommandOutcome(value: unknown): CommandOutcome | null {
  if (!isRecord(value) || typeof value.outcome !== 'string'
    || !['finished', 'failed', 'interrupted', 'unknown'].includes(value.outcome)
    || (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || Number(value.exitCode) < 0))
    || (value.signal !== null && typeof value.signal !== 'string')
    || (value.capture !== 'complete' && value.capture !== 'incomplete')) return null;
  const cwd = parseCommandWorkingDirectory(value.cwd);
  if (!cwd) return null;
  return {
    outcome: value.outcome as CommandOutcome['outcome'],
    exitCode: value.exitCode as number | null,
    signal: value.signal as string | null,
    capture: value.capture,
    cwd,
  };
}

export function commandOutcomeText(result: CommandOutcome): string {
  let status: string;
  switch (result.outcome) {
    case 'finished':
      status = 'Completed';
      break;
    case 'interrupted':
      status = 'Interrupted';
      break;
    case 'unknown':
      status = 'Outcome unknown';
      break;
    default:
      status = result.exitCode !== null ? `Exit ${result.exitCode}` : 'Command failed';
  }

  const lines = [status];
  if (result.signal) lines.push(`Signal: ${result.signal}`);
  if (result.capture === 'incomplete') lines.push('Output capture incomplete');
  if (result.cwd.kind === 'unavailable') {
    lines.push(`Working directory not captured: ${result.cwd.reason}`);
  }
  return lines.join('\n');
}
