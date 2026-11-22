import { expect, test } from 'bun:test';
import { compareCliVersions, parseCliVersion } from '../cli-version.js';

test('parses the version forms that Claude Code and Codex print', () => {
  expect(parseCliVersion('2.1.238 (Claude Code)\n')).toBe('2.1.238');
  expect(parseCliVersion('codex-cli 0.169.0\n')).toBe('0.169.0');
  expect(parseCliVersion('codex-cli 0.170.0-alpha.1')).toBe('0.170.0-alpha.1');
  expect(parseCliVersion('v1.4.3')).toBe('1.4.3');
  expect(parseCliVersion('mise ERROR tool not installed')).toBeNull();
  expect(parseCliVersion('build 12.3.4.5')).toBeNull();
});

test('orders releases numerically and ranks prereleases below their release', () => {
  expect(compareCliVersions('2.1.238', '2.1.300')).toBe(-1);
  expect(compareCliVersions('2.10.0', '2.9.9')).toBe(1);
  expect(compareCliVersions('0.169.0', '0.169.0')).toBe(0);
  expect(compareCliVersions('0.170.0-alpha.1', '0.170.0')).toBe(-1);
  expect(compareCliVersions('0.170.0-alpha.2', '0.170.0-alpha.10')).toBe(-1);
  expect(compareCliVersions('0.170.0-beta', '0.170.0-alpha.3')).toBe(1);
  expect(compareCliVersions('latest', '1.0.0')).toBeNull();
});
