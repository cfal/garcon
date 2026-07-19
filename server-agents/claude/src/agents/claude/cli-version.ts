// Probes the installed Claude CLI version to decide whether the legacy
// `--thinking` flag (removed in Claude Code 2.1.198) can still be forwarded.

import { createLogger } from '@garcon/server-agent-common/lib/log';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';

const logger = createLogger('agents:claude:cli-version');

// First Claude Code version without the legacy `--thinking` flag.
const THINKING_FLAG_REMOVED_VERSION: readonly [number, number, number] = [2, 1, 198];

const VERSION_PROBE_TIMEOUT_MS = 5000;

// Memoizes probe results per binary path so each CLI is probed once per
// server lifetime. Keyed by path: a binary swap mid-flight would require a
// restart anyway, and re-probing per spawn would add latency to every turn.
const legacyThinkingFlagSupport = new Map<string, Promise<boolean>>();

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
function claudeCliSupportsLegacyThinkingFlag(claudeBinary: string): Promise<boolean> {
  let cached = legacyThinkingFlagSupport.get(claudeBinary);
  if (!cached) {
    cached = probeClaudeCliVersion(claudeBinary)
      .then((version) => {
        if (!version) {
          logger.warn(`could not parse Claude CLI version for ${claudeBinary}; assuming --thinking is unsupported`);
          return false;
        }
        return isVersionBefore(version, THINKING_FLAG_REMOVED_VERSION);
      })
      .catch((err: unknown) => {
        logger.warn(`Claude CLI version probe failed for ${claudeBinary}:`, errorMessage(err));
        return false;
      });
    legacyThinkingFlagSupport.set(claudeBinary, cached);
  }
  return cached;
}

export { claudeCliSupportsLegacyThinkingFlag, isVersionBefore, parseClaudeCliVersion, THINKING_FLAG_REMOVED_VERSION };
