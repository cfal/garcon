import type { AgentModelOption } from '@garcon/common/agents';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { antigravityChildEnvironment, type AntigravityConfig } from '../../config.js';

const MODELS_TIMEOUT_MS = 10_000;

export interface AntigravityCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

const inFlightModels = new Map<string, Promise<AntigravityCliResult>>();

// `agy models` is the CLI's signed-in check as well as its catalog; unlike
// `session/new`, it leaves no empty conversation in the user's history. Auth
// status and catalog discovery run together, so concurrent callers share one
// process.
export function runAntigravityModels(config: AntigravityConfig): Promise<AntigravityCliResult> {
  const binary = config.binary();
  const running = inFlightModels.get(binary);
  if (running) return running;
  const started = spawnAntigravityModels(binary).finally(() => inFlightModels.delete(binary));
  inFlightModels.set(binary, started);
  return started;
}

async function spawnAntigravityModels(binary: string): Promise<AntigravityCliResult> {
  const proc = Bun.spawn([binary, 'models'], {
    env: antigravityChildEnvironment(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited.catch(() => null),
  ]);
  return { stdout, stderr, exitCode };
}

// Each line is `<id>\t<label>`, where the id encodes the model and its
// thinking level, for example `gemini-3.1-pro-high\tGemini 3.1 Pro (High)`.
export function parseAntigravityModels(output: string): AgentModelOption[] {
  const models: AgentModelOption[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const [rawId, ...labelParts] = line.split('\t');
    const id = rawId?.trim();
    if (!id || labelParts.length === 0 || seen.has(id)) continue;
    seen.add(id);
    models.push({ value: id, label: labelParts.join('\t').trim() || id, supportsImages: true });
  }
  return models;
}

export function antigravityCliFailure(result: AntigravityCliResult): string {
  const detail = (result.stderr || result.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Fetching available models/i.test(line))
    .join(' ');
  return detail.replace(/^Error:\s*/i, '')
    || `agy models exited with code ${result.exitCode ?? 'unknown'}`;
}

export async function getAntigravityModels(
  config: AntigravityConfig,
  logger: AgentLogger,
): Promise<AgentModelOption[]> {
  try {
    const result = await runAntigravityModels(config);
    if (result.exitCode === 0) return parseAntigravityModels(result.stdout);
    logger.warn('Antigravity model discovery failed', { error: antigravityCliFailure(result) });
  } catch (error) {
    logger.warn('Antigravity model discovery failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return [];
}
