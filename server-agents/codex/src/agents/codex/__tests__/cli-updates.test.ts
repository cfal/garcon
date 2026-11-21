import { expect, test } from 'bun:test';
import { codexStandaloneHome, parseCodexChannelRelease } from '../cli-updates.js';

test('finds the CODEX_HOME that owns a standalone install', () => {
  expect(codexStandaloneHome('/home/u/.codex/packages/standalone/0.170.0/bin/codex')).toBe('/home/u/.codex');
  expect(codexStandaloneHome('C:\\Users\\u\\.codex\\packages\\standalone\\0.170.0\\codex.exe')).toBe('C:\\Users\\u\\.codex');
  expect(codexStandaloneHome('/packages/standalone/codex')).toBe('/');
  expect(codexStandaloneHome('/usr/local/lib/node_modules/@openai/codex/bin/codex.js')).toBeNull();
});

test('reads the native channel release tag', () => {
  expect(parseCodexChannelRelease('{"tag_name":"rust-v0.170.0"}')).toBe('0.170.0');
  expect(parseCodexChannelRelease('{"tag_name":"v0.170.0"}')).toBeNull();
  expect(parseCodexChannelRelease('<html>')).toBeNull();
});
