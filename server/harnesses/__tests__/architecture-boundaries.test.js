import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') || path.endsWith('.js') ? [path] : [];
  });
}

describe('harness architecture boundaries', () => {
  test('keeps server/acp protocol-only', () => {
    for (const file of walk('server/acp')) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('common/chat-types');
      expect(source).not.toContain('providers/base');
      expect(source).not.toContain('harnesses/');
    }
  });

  test('does not keep the transitional adapter/plugin layer', () => {
    expect(existsSync('server/providers/provider-adapter.ts')).toBe(false);
    expect(existsSync('server/providers/provider-adapters.ts')).toBe(false);
    expect(existsSync('server/providers/harness-plugin.ts')).toBe(false);
    expect(existsSync('server/providers/harness-plugin-bridge.ts')).toBe(false);
  });

  test('composition root creates Cursor through the Cursor harness factory', () => {
    const source = readFileSync('server/server.js', 'utf8');
    expect(source).toContain('createCursorHarness');
    expect(source).not.toContain('CursorRequestIdentityStore');
    expect(source).not.toContain('adapterToHarness');
  });
});
