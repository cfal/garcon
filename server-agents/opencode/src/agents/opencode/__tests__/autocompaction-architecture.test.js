import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { buildOpenCodeServerEnv } from '../server-instance.ts';

const PACKAGE_ROOT = new URL('../../../../', import.meta.url);

describe('OpenCode V1 automatic compaction architecture', () => {
  it('[TLV5-OPENCODE.02-UNIT-01] does not force autocompaction off and preserves operator overrides', () => {
    const environment = buildOpenCodeServerEnv(
      {
        KEEP_ME: 'yes',
        OPENCODE_DISABLE_AUTOCOMPACT: '0',
        OPENCODE_DISABLE_AUTOUPDATE: '0',
        OPENCODE_PURE: '1',
      },
    );

    expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? '{}').plugin).toHaveLength(1);
    expect(environment).toMatchObject({
      KEEP_ME: 'yes',
      OPENCODE_DISABLE_AUTOCOMPACT: '0',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    });
    expect(buildOpenCodeServerEnv({})).not.toHaveProperty('OPENCODE_DISABLE_AUTOCOMPACT');
    expect(environment).not.toHaveProperty('OPENCODE_PURE');
  });

  it('[TLV5-OPENCODE.02-STATIC-01] keeps compaction enabled without the retired operation identity plugin', () => {
    const serverInstance = readFileSync(new URL('../server-instance.ts', import.meta.url), 'utf8');
    const manifest = JSON.parse(readFileSync(new URL('package.json', PACKAGE_ROOT), 'utf8'));

    expect(serverInstance).not.toContain('OPENCODE_DISABLE_AUTOCOMPACT');
    expect(serverInstance).not.toContain('operation-identity-plugin');
    expect(serverInstance).not.toContain("'--pure'");
    expect(manifest.garconBuild.preMainModules).toEqual([
      './src/build/prepare-compiled-runtime.ts',
    ]);
    expect(existsSync(new URL('../garcon-session-identity.mjs', import.meta.url))).toBe(true);
  });
});
