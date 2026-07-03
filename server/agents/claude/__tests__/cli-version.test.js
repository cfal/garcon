import { describe, it, expect } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { claudeCliSupportsLegacyThinkingFlag, isVersionBefore, parseClaudeCliVersion, THINKING_FLAG_REMOVED_VERSION } from '../cli-version.js';

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
    expect(isVersionBefore([2, 1, 197], THINKING_FLAG_REMOVED_VERSION)).toBe(true);
    expect(isVersionBefore([1, 9, 999], THINKING_FLAG_REMOVED_VERSION)).toBe(true);
    expect(isVersionBefore([2, 1, 198], THINKING_FLAG_REMOVED_VERSION)).toBe(false);
    expect(isVersionBefore([2, 2, 0], THINKING_FLAG_REMOVED_VERSION)).toBe(false);
    expect(isVersionBefore([3, 0, 0], THINKING_FLAG_REMOVED_VERSION)).toBe(false);
  });
});

describe('claudeCliSupportsLegacyThinkingFlag', () => {
  it('reports support for CLIs older than the flag removal', async () => {
    const { binaryPath } = await createFakeClaudeBinary('2.1.150 (Claude Code)');
    expect(await claudeCliSupportsLegacyThinkingFlag(binaryPath)).toBe(true);
  });

  it('reports no support for CLIs at or beyond the flag removal', async () => {
    const removed = await createFakeClaudeBinary('2.1.198 (Claude Code)');
    const newer = await createFakeClaudeBinary('2.2.0 (Claude Code)');
    expect(await claudeCliSupportsLegacyThinkingFlag(removed.binaryPath)).toBe(false);
    expect(await claudeCliSupportsLegacyThinkingFlag(newer.binaryPath)).toBe(false);
  });

  it('defaults to no support when the version cannot be determined', async () => {
    const { binaryPath } = await createFakeClaudeBinary('mystery build');
    expect(await claudeCliSupportsLegacyThinkingFlag(binaryPath)).toBe(false);
    expect(await claudeCliSupportsLegacyThinkingFlag('/nonexistent/claude-binary')).toBe(false);
  });

  it('probes each binary path only once', async () => {
    const { binaryPath, callLogPath } = await createFakeClaudeBinary('2.0.0 (Claude Code)');
    expect(await claudeCliSupportsLegacyThinkingFlag(binaryPath)).toBe(true);
    expect(await claudeCliSupportsLegacyThinkingFlag(binaryPath)).toBe(true);
    const calls = await fs.readFile(callLogPath, 'utf8');
    expect(calls.trim().split('\n')).toHaveLength(1);
  });
});
