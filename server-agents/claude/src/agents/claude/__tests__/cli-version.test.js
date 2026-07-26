import { describe, it, expect } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  ClaudeCliVersionProbe,
  isVersionBefore,
  MINIMUM_CLAUDE_CLI_VERSION,
  parseClaudeCliVersion,
} from '../cli-version.js';

// Writes an executable fake `claude` binary that logs each invocation and
// prints the given --version output.
async function createFakeClaudeBinary(versionOutput) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-cli-version-'));
  const binaryPath = path.join(dir, 'claude');
  const callLogPath = path.join(dir, 'calls.log');
  await fs.writeFile(binaryPath, `#!/bin/sh\necho probe >> ${callLogPath}\necho "${versionOutput}"\n`, { mode: 0o755 });
  return { binaryPath, callLogPath };
}

describe('parseClaudeCliVersion', () => {
  it('parses the semver from Claude Code version output', () => {
    expect(parseClaudeCliVersion('2.1.198 (Claude Code)')).toEqual([2, 1, 198]);
    expect(parseClaudeCliVersion('1.0.44 (Claude Code)\n')).toEqual([1, 0, 44]);
  });

  it('returns null for unparseable output', () => {
    expect(parseClaudeCliVersion('')).toBeNull();
    expect(parseClaudeCliVersion('not a version')).toBeNull();
  });
});

describe('isVersionBefore', () => {
  it('compares versions numerically per component', () => {
    expect(isVersionBefore([2, 1, 219], MINIMUM_CLAUDE_CLI_VERSION)).toBe(true);
    expect(isVersionBefore([1, 9, 999], MINIMUM_CLAUDE_CLI_VERSION)).toBe(true);
    expect(isVersionBefore([2, 1, 220], MINIMUM_CLAUDE_CLI_VERSION)).toBe(false);
    expect(isVersionBefore([2, 2, 0], MINIMUM_CLAUDE_CLI_VERSION)).toBe(false);
    expect(isVersionBefore([3, 0, 0], MINIMUM_CLAUDE_CLI_VERSION)).toBe(false);
  });
});

function createProbe() {
  return new ClaudeCliVersionProbe();
}

describe('ClaudeCliVersionProbe', () => {
  it('requires the tested persistent protocol version', async () => {
    const supported = await createFakeClaudeBinary('2.1.220 (Claude Code)');
    const unsupported = await createFakeClaudeBinary('2.1.219 (Claude Code)');

    await expect(createProbe().assertCompatible(supported.binaryPath))
      .resolves.toEqual(MINIMUM_CLAUDE_CLI_VERSION);
    await expect(createProbe().assertCompatible(unsupported.binaryPath))
      .rejects.toThrow('Upgrade to 2.1.220 or newer');
  });

  it('probes each binary path only once', async () => {
    const { binaryPath, callLogPath } = await createFakeClaudeBinary('2.1.220 (Claude Code)');
    const probe = createProbe();
    expect(await probe.assertCompatible(binaryPath)).toEqual(MINIMUM_CLAUDE_CLI_VERSION);
    expect(await probe.assertCompatible(binaryPath)).toEqual(MINIMUM_CLAUDE_CLI_VERSION);
    const calls = await fs.readFile(callLogPath, 'utf8');
    expect(calls.trim().split('\n')).toHaveLength(1);
  });
});
