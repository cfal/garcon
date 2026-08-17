import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { buildOpenCodeServerEnv } from '../server-instance.ts';

const PACKAGE_ROOT = new URL('../../../../', import.meta.url);

describe('OpenCode V1 automatic compaction architecture', () => {
  it('[TLV5-OPENCODE.02-UNIT-01] forces autocompaction off in the owned server environment', () => {
    const environment = buildOpenCodeServerEnv(
      {
        KEEP_ME: 'yes',
        OPENCODE_DISABLE_AUTOCOMPACT: '0',
        OPENCODE_DISABLE_AUTOUPDATE: '0',
        OPENCODE_PURE: '1',
      },
    );

    expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? '{}')).not.toHaveProperty('plugin');
    expect(environment).toMatchObject({
      KEEP_ME: 'yes',
      OPENCODE_DISABLE_AUTOCOMPACT: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    });
    expect(environment).not.toHaveProperty('OPENCODE_PURE');
  });

  it('[TLV5-OPENCODE.02-STATIC-01] disables provider autocompaction and removes session-latest continuation support', () => {
    const serverInstance = readFileSync(new URL('../server-instance.ts', import.meta.url), 'utf8');
    const manifest = JSON.parse(readFileSync(new URL('package.json', PACKAGE_ROOT), 'utf8'));

    expect(serverInstance).toContain("OPENCODE_DISABLE_AUTOCOMPACT: '1'");
    expect(serverInstance).not.toContain('operation-identity-plugin');
    expect(manifest.garconBuild).not.toHaveProperty('standaloneEntrypoints');
    expect(manifest.exports).not.toHaveProperty('./operation-identity-plugin');
    expect(existsSync(new URL('../operation-identity-plugin.js', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../operation-identity-plugin-host.ts', import.meta.url))).toBe(false);
  });
});
