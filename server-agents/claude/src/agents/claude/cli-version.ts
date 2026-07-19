// Probes the installed Claude CLI version to decide whether the legacy
// `--thinking` flag (removed in Claude Code 2.1.198) can still be forwarded.

import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { AgentLogger } from '@garcon/server-agent-interface';

// First Claude Code version without the legacy `--thinking` flag.
const THINKING_FLAG_REMOVED_VERSION: readonly [number, number, number] = [2, 1, 198];

const VERSION_PROBE_TIMEOUT_MS = 5000;

type CliVersion = readonly [number, number, number];

function parseClaudeCliVersion(output: string): CliVersion | null {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionBefore(version: CliVersion, threshold: CliVersion): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== threshold[i]) return version[i] < threshold[i];
  }
  return false;
}

async function probeClaudeCliVersion(claudeBinary: string): Promise<CliVersion | null> {
  const proc = Bun.spawn([claudeBinary, '--version'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });

  const killTimer = setTimeout(() => {
    if (!proc.killed) proc.kill();
  }, VERSION_PROBE_TIMEOUT_MS);

  try {
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return parseClaudeCliVersion(output);
  } finally {
    clearTimeout(killTimer);
  }
}

// Resolves true only when the CLI predates the `--thinking` removal.
// Defaults to false on probe failure: omitting the flag is harmless on old
// CLIs, while passing it makes newer CLIs reject the session.
export class ClaudeCliVersionProbe {
  readonly #legacyThinkingFlagSupport = new Map<string, Promise<boolean>>();

  constructor(private readonly logger: AgentLogger) {}

  supportsLegacyThinkingFlag(claudeBinary: string): Promise<boolean> {
    let cached = this.#legacyThinkingFlagSupport.get(claudeBinary);
    if (!cached) {
      cached = probeClaudeCliVersion(claudeBinary)
        .then((version) => {
          if (!version) {
            this.logger.warn('Could not parse Claude CLI version; legacy thinking disabled', {
              binary: claudeBinary,
            });
            return false;
          }
          return isVersionBefore(version, THINKING_FLAG_REMOVED_VERSION);
        })
        .catch((error: unknown) => {
          this.logger.warn('Claude CLI version probe failed; legacy thinking disabled', {
            binary: claudeBinary,
            error: errorMessage(error),
          });
          return false;
        });
      this.#legacyThinkingFlagSupport.set(claudeBinary, cached);
    }
    return cached;
  }
}

export { isVersionBefore, parseClaudeCliVersion, THINKING_FLAG_REMOVED_VERSION };
