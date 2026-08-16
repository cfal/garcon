import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

const PACKAGE_ROOT = new URL('../../../../', import.meta.url);

describe('OpenCode V1 automatic compaction architecture', () => {
  it('[TLV5-OPENCODE.02-STATIC-01] disables provider autocompaction and removes session-latest continuation support', () => {
    const serverInstance = readFileSync(new URL('../server-instance.ts', import.meta.url), 'utf8');
    const manifest = JSON.parse(readFileSync(new URL('package.json', PACKAGE_ROOT), 'utf8'));

    expect(serverInstance).toContain("OPENCODE_DISABLE_AUTOCOMPACT: '1'");
    expect(serverInstance).not.toContain('operation-identity-plugin');
    expect(manifest.garconBuild?.standaloneEntrypoints ?? {}).not.toHaveProperty(
      'operation-identity-plugin',
    );
    expect(existsSync(new URL('../operation-identity-plugin.js', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../operation-identity-plugin-host.ts', import.meta.url))).toBe(false);
  });
});
