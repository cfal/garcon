const MINIMUM_CLAUDE_CLI_VERSION: readonly [number, number, number] = [2, 1, 220];
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_EXIT_GRACE_MS = 1_000;
const MAX_VERSION_OUTPUT_BYTES = 16 * 1024;

type CliVersion = readonly [number, number, number];

export interface ClaudeCliVersionCheck {
  readonly result: Promise<CliVersion>;
  /** Retains the probe's exit and readers even after its result times out. */
  readonly drained: Promise<void>;
}

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

function versionText(version: CliVersion): string {
  return version.join('.');
}

async function waitForExit(
  process: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<number | null> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      process.exited,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readProbeOutput(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_VERSION_OUTPUT_BYTES) {
        throw new Error('Claude CLI version output exceeded its size limit');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

async function probeClaudeCliVersion(
  claudeBinary: string,
  drainage: ReturnType<typeof Promise.withResolvers<void>>,
): Promise<CliVersion> {
  let process: import('bun').Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    process = Bun.spawn([claudeBinary, '--version'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    drainage.reject(error);
    throw error;
  }
  const stdout = readProbeOutput(process.stdout);
  const stderr = readProbeOutput(process.stderr);
  void Promise.allSettled([process.exited, stdout, stderr]).then((completions) => {
    const failure = completions.find((completion) => completion.status === 'rejected');
    if (failure) drainage.reject(failure.reason);
    else drainage.resolve();
  });

  let exitCode = await waitForExit(process, VERSION_PROBE_TIMEOUT_MS);
  if (exitCode === null) {
    if (!process.killed) process.kill();
    exitCode = await waitForExit(process, VERSION_PROBE_EXIT_GRACE_MS);
  }
  if (exitCode === null) {
    process.kill('SIGKILL');
    exitCode = await waitForExit(process, VERSION_PROBE_EXIT_GRACE_MS);
  }
  if (exitCode === null) {
    throw new Error('Claude CLI version probe did not exit after SIGKILL');
  }

  const [output, errorOutput] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0) {
    const detail = errorOutput.trim();
    throw new Error(
      detail
        ? `Claude CLI version probe exited with code ${exitCode}: ${detail}`
        : `Claude CLI version probe exited with code ${exitCode}`,
    );
  }
  const version = parseClaudeCliVersion(output);
  if (!version) throw new Error('Could not parse the installed Claude CLI version');
  return version;
}

export class ClaudeCliVersionProbe {
  readonly #versions = new Map<string, ClaudeCliVersionCheck>();

  async assertCompatible(claudeBinary: string): Promise<CliVersion> {
    return this.check(claudeBinary).result;
  }

  check(claudeBinary: string): ClaudeCliVersionCheck {
    const probe = this.#version(claudeBinary);
    return { result: this.#assertCompatible(probe.result), drained: probe.drained };
  }

  async #assertCompatible(result: Promise<CliVersion>): Promise<CliVersion> {
    const version = await result;
    if (isVersionBefore(version, MINIMUM_CLAUDE_CLI_VERSION)) {
      throw new Error(
        `Claude Code ${versionText(version)} is unsupported.`
          + ` Upgrade to ${versionText(MINIMUM_CLAUDE_CLI_VERSION)} or newer.`,
      );
    }
    return version;
  }

  #version(claudeBinary: string): ClaudeCliVersionCheck {
    let cached = this.#versions.get(claudeBinary);
    if (!cached) {
      const drainage = Promise.withResolvers<void>();
      void drainage.promise.catch(() => undefined);
      cached = { result: probeClaudeCliVersion(claudeBinary, drainage), drained: drainage.promise };
      this.#versions.set(claudeBinary, cached);
      void cached.result.catch(() => {
        if (this.#versions.get(claudeBinary) === cached) {
          this.#versions.delete(claudeBinary);
        }
      });
    }
    return cached;
  }
}

export {
  isVersionBefore,
  MINIMUM_CLAUDE_CLI_VERSION,
  parseClaudeCliVersion,
};
