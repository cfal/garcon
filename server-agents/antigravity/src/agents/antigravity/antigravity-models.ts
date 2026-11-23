import type { AgentModelOption } from '@garcon/common/agents';
import { AgentIntegrationError, type AgentLogger } from '@garcon/server-agent-interface';
import { createModelCatalog } from '@garcon/server-agent-common/catalog/model-catalog';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import { antigravityChildEnvironment, classifyAntigravityLaunchError, type AntigravityConfig } from '../../config.js';
import { waitUnlessAborted } from '@garcon/server-agent-common/shared/shared-probe';

const MODELS_TIMEOUT_MS = 10_000;

export interface AntigravityCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export async function runAntigravityModels(config: AntigravityConfig, timeoutMs = MODELS_TIMEOUT_MS): Promise<AntigravityCliResult> {
  const binary = config.binary();
  const env = antigravityChildEnvironment(config);
  let proc;
  try {
    proc = Bun.spawn([binary, 'models'], {
      env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
  } catch (error) {
    throw classifyAntigravityLaunchError(error);
  }
  const stdout = pipeText(proc.stdout);
  const stderr = pipeText(proc.stderr);
  // A descendant can keep the pipes open after agy exits, so the deadline covers reads as well as exit.
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(`agy models timed out after ${timeoutMs} ms`)), timeoutMs);
  try {
    const [stdoutText, stderrText, exitCode] = await Promise.race([
      Promise.all([stdout.text, stderr.text, proc.exited.catch(() => null)]),
      timeout.promise,
    ]);
    return { stdout: stdoutText, stderr: stderrText, exitCode };
  } catch (error) {
    proc.kill('SIGKILL');
    stdout.cancel();
    stderr.cancel();
    throw error;
  } finally {
    clearTimeout(timer);
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
    .join(' ')
    .replace(/^Error:\s*/i, '');
  const status = `agy models exited with code ${result.exitCode ?? 'unknown'}`;
  return detail ? `${status}: ${detail}` : status;
}

export function createAntigravityCatalog(runModels: () => Promise<AntigravityCliResult>, logger: AgentLogger) {
  const nativeDefault = { value: 'default', label: 'Default', supportsImages: true };
  return createModelCatalog({
    logger,
    defaultModel: 'default',
    fallbackModels: [],
    requiresStrictModelDiscovery: false,
    // Disposable generation sessions remain in agy's native history.
    generation: null,
    discover: ({ signal, requireNativeDiscovery }) => waitUnlessAborted(getAntigravityModels(requireNativeDiscovery), signal),
  });

  async function getAntigravityModels(requireNativeDiscovery = false): Promise<AgentModelOption[]> {
    try {
      const result = await runModels();
      if (result.exitCode === 0) return [nativeDefault, ...parseAntigravityModels(result.stdout)];
      throw new Error(antigravityCliFailure(result));
    } catch (error) {
      if (error instanceof AgentIntegrationError && (error.code === 'BINARY_NOT_FOUND' || error.code === 'INVALID_SETTINGS')) {
        throw error;
      }
      if (requireNativeDiscovery) throw new AgentIntegrationError('UNAVAILABLE', errorMessage(error), true);
      logger.warn('Antigravity model discovery failed', { error: errorMessage(error) });
    }
    return [nativeDefault];
  }
}
