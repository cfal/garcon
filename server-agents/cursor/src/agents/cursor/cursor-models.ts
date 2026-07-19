import type { AgentLogger } from '@garcon/server-agent-interface';
import type { CursorConfig } from '../../config.js';

export interface CursorModelOption {
  value: string;
  label: string;
  supportsImages?: boolean;
}

function titleCaseModel(value: string): string {
  if (value === 'auto') return 'Auto';
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.toUpperCase() === part
      ? part
      : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseCursorModelLine(line: string): CursorModelOption | null {
  const trimmed = line.trim();
  if (!trimmed || /no models available/i.test(trimmed)) return null;
  const normalized = trimmed.replace(/^[-*]\s+/, '');
  const match = normalized.match(/^([a-zA-Z0-9][a-zA-Z0-9._:/+-]*)(?:\s+[-–—]\s+(.+)|\s+\((.+)\))?$/);
  if (!match) return null;
  const value = match[1];
  if (['model', 'models', 'available'].includes(value.toLowerCase())) return null;
  return {
    value,
    label: (match[2] || match[3] || titleCaseModel(value)).trim(),
    supportsImages: false,
  };
}

export function parseCursorModelsOutput(output: string): CursorModelOption[] {
  const models: CursorModelOption[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const model = parseCursorModelLine(line);
    if (!model || seen.has(model.value)) continue;
    seen.add(model.value);
    models.push(model);
  }
  return models;
}

async function runCursorModels(config: CursorConfig): Promise<string> {
  const proc = Bun.spawn([config.binary(), 'models'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(10_000),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(''),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(''),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const details = (stderr || stdout || '').trim();
    throw new Error(`Cursor model discovery failed with code ${exitCode}${details ? `: ${details}` : ''}`);
  }
  return stdout;
}

export async function getCursorModels(
  config: CursorConfig,
  logger: AgentLogger,
): Promise<CursorModelOption[]> {
  try {
    const parsed = parseCursorModelsOutput(await runCursorModels(config));
    if (parsed.length > 0) return parsed;
  } catch (error) {
    logger.warn('Cursor model discovery failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return [];
}
