import type { AgentModelOption } from '@garcon/common/agents';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import { antigravityChildEnvironment, type AntigravityConfig } from '../../config.js';
import { sharedProbe, waitUnlessAborted } from '@garcon/server-agent-common/shared/shared-probe';

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
  // Shared only by callers that would run the identical probe.
  const env = antigravityChildEnvironment(config);
  const key = JSON.stringify([binary, env.GEMINI_API_KEY ?? null]);
  return sharedProbe(inFlightModels, key, () => spawnAntigravityModels(binary, env));
}

async function spawnAntigravityModels(
  binary: string,
  env: Record<string, string | undefined>,
): Promise<AntigravityCliResult> {
  const proc = Bun.spawn([binary, 'models'], {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
  });
  const stdout = pipeText(proc.stdout);
  const stderr = pipeText(proc.stderr);
  // The signal kills only agy; a descendant holding its pipes would keep the
  // reads open, so the shared probe has its own deadline that releases them.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => {
      proc.kill();
      stdout.cancel();
      stderr.cancel();
      reject(new Error(`agy models did not finish within ${MODELS_TIMEOUT_MS / 1000} s`));
    }, MODELS_TIMEOUT_MS + 1_000);
  });
  try {
    const [stdoutText, stderrText, exitCode] = await Promise.race([
      Promise.all([stdout.text, stderr.text, proc.exited.catch(() => null)]),
      timedOut,
    ]);
    return { stdout: stdoutText, stderr: stderrText, exitCode };
  } finally {
    clearTimeout(deadline);
  }
}

function pipeText(stream: ReadableStream<Uint8Array>): { readonly text: Promise<string>; cancel(): void } {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const text = (async () => {
    let output = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return output + decoder.decode();
      output += decoder.decode(value, { stream: true });
    }
  })();
  return { text, cancel: () => void reader.cancel().catch(() => {}) };
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

export function createAntigravityCatalog(config: AntigravityConfig, logger: AgentLogger) {
  return createModelCatalog({
    logger,
    defaultModel: 'default',
    fallbackModels: [{ value: 'default', label: 'Default', supportsImages: true }],
    requiresStrictModelDiscovery: false,
    // Disposable generation sessions remain in agy's native history.
    generation: null,
    discover: ({ signal }) => waitUnlessAborted(getAntigravityModels(config, logger), signal),
  });
}

async function getAntigravityModels(
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
