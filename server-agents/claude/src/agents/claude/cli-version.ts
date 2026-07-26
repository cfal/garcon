const MINIMUM_CLAUDE_CLI_VERSION: readonly [number, number, number] = [2, 1, 220];
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_EXIT_GRACE_MS = 1_000;
const MAX_VERSION_OUTPUT_BYTES = 16 * 1024;

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
}

async function probeClaudeCliVersion(claudeBinary: string): Promise<CliVersion> {
  const process = Bun.spawn([claudeBinary, '--version'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = readProbeOutput(process.stdout);
  const stderr = readProbeOutput(process.stderr);

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
  readonly #versions = new Map<string, Promise<CliVersion>>();

  async assertCompatible(claudeBinary: string): Promise<CliVersion> {
    const version = await this.#version(claudeBinary);
    if (isVersionBefore(version, MINIMUM_CLAUDE_CLI_VERSION)) {
      throw new Error(
        `Claude Code ${versionText(version)} is unsupported.`
          + ` Upgrade to ${versionText(MINIMUM_CLAUDE_CLI_VERSION)} or newer.`,
      );
    }
    return version;
  }

  #version(claudeBinary: string): Promise<CliVersion> {
    let cached = this.#versions.get(claudeBinary);
    if (!cached) {
      cached = probeClaudeCliVersion(claudeBinary);
      this.#versions.set(claudeBinary, cached);
    }
    return cached;
  }
}

export {
  isVersionBefore,
  MINIMUM_CLAUDE_CLI_VERSION,
  parseClaudeCliVersion,
};
