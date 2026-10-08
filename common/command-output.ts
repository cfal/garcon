import { isRecord } from './json.js';

export interface CommandOutputContext {
  readonly executorId: string;
  readonly projectPath: string;
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
  if (!isRecord(value) || !['finished', 'failed', 'interrupted', 'unknown'].includes(String(value.outcome))
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
  const status = result.outcome === 'finished' ? 'Completed'
    : result.outcome === 'interrupted' ? 'Interrupted'
      : result.outcome === 'unknown' ? 'Outcome unknown'
        : result.exitCode !== null ? `Exit ${result.exitCode}` : 'Command failed';
  return [
    status,
    ...(result.signal ? [`Signal: ${result.signal}`] : []),
    ...(result.capture === 'incomplete' ? ['Output capture incomplete'] : []),
    ...(result.cwd.kind === 'unavailable' ? [`Working directory not captured: ${result.cwd.reason}`] : []),
  ].join('\n');
}
