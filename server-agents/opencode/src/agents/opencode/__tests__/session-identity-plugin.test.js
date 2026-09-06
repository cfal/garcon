import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GarconSessionIdentity } from '../garcon-session-identity.mjs';
import {
  buildOpenCodeServerEnv,
  mergeOpenCodeConfigContent,
} from '../server-instance.ts';
import { resolveSessionIdentityPluginUrl } from '../session-identity-plugin.ts';

const GARCON_PLUGIN_URL = 'file:///opt/garcon/garcon-session-identity.mjs';

describe('OpenCode session identity plugin', () => {
  it('uses each shell invocation session ID without retaining another call', async () => {
    const hooks = await GarconSessionIdentity();
    const first = { env: { KEEP_FIRST: 'yes' } };
    const second = { env: { KEEP_SECOND: 'yes' } };

    await Promise.all([
      hooks['shell.env']({ sessionID: 'session-first' }, first),
      hooks['shell.env']({ sessionID: 'session-second' }, second),
    ]);

    expect(first.env).toEqual({ KEEP_FIRST: 'yes', OPENCODE_SESSION_ID: 'session-first' });
    expect(second.env).toEqual({ KEEP_SECOND: 'yes', OPENCODE_SESSION_ID: 'session-second' });
  });

  it('removes inherited and prior values when an invocation has no session ID', async () => {
    const hooks = await GarconSessionIdentity();
    const output = { env: { KEEP_ME: 'yes', OPENCODE_SESSION_ID: 'ambient' } };

    await hooks['shell.env']({ sessionID: 'session-present' }, output);
    await hooks['shell.env']({}, output);

    expect(output.env).toEqual({ KEEP_ME: 'yes' });
  });
});

describe('OpenCode inline configuration composition', () => {
  it('adds the Garcon plugin without inherited inline content', () => {
    expect(JSON.parse(mergeOpenCodeConfigContent(undefined, GARCON_PLUGIN_URL))).toEqual({
      plugin: [GARCON_PLUGIN_URL],
    });
  });

  it('treats blank inherited inline content as absent', () => {
    expect(JSON.parse(mergeOpenCodeConfigContent('  \n', GARCON_PLUGIN_URL))).toEqual({
      plugin: [GARCON_PLUGIN_URL],
    });
  });

  it('preserves JSONC fields, string plugins, and plugin tuples', () => {
    const content = `{
      // Operator-owned inline settings stay intact.
      "mode": "user",
      "plugin": [
        "file:///opt/user/plugin.js",
        ["package-plugin", { "enabled": true }],
      ],
    }`;

    expect(JSON.parse(mergeOpenCodeConfigContent(content, GARCON_PLUGIN_URL))).toEqual({
      mode: 'user',
      plugin: [
        'file:///opt/user/plugin.js',
        ['package-plugin', { enabled: true }],
        GARCON_PLUGIN_URL,
      ],
    });
  });

  it('does not duplicate an identical Garcon plugin tuple', () => {
    const existing = [GARCON_PLUGIN_URL, { configured: true }];
    const merged = JSON.parse(mergeOpenCodeConfigContent(
      JSON.stringify({ plugin: ['user-plugin', existing] }),
      GARCON_PLUGIN_URL,
    ));

    expect(merged.plugin).toEqual(['user-plugin', existing]);
  });

  it('preserves URL-sensitive path characters through a file URL', () => {
    const pluginUrl = pathToFileURL('/opt/Garçon plugins/100% session #1.mjs').href;
    const merged = JSON.parse(mergeOpenCodeConfigContent(undefined, pluginUrl));

    expect(merged.plugin).toEqual([
      'file:///opt/Gar%C3%A7on%20plugins/100%25%20session%20%231.mjs',
    ]);
  });

  it.each([
    {
      description: 'invalid JSONC',
      content: '{ broken',
      expected: 'Invalid inherited OPENCODE_CONFIG_CONTENT at offset',
    },
    {
      description: 'trailing content',
      content: '{} trailing',
      expected: 'Invalid inherited OPENCODE_CONFIG_CONTENT at offset',
    },
    {
      description: 'a non-object root',
      content: '[]',
      expected: 'Invalid inherited OPENCODE_CONFIG_CONTENT: expected a JSONC object.',
    },
    {
      description: 'a non-array plugin field',
      content: '{ "plugin": "wrong" }',
      expected: 'Invalid inherited OPENCODE_CONFIG_CONTENT: "plugin" must be an array.',
    },
    {
      description: 'an invalid plugin tuple',
      content: '{ "plugin": [["incomplete"]] }',
      expected:
        'Invalid inherited OPENCODE_CONFIG_CONTENT: "plugin[0]" must be a string or [specifier, options] tuple.',
    },
  ])('fails clearly for $description', ({ content, expected }) => {
    expect(() => mergeOpenCodeConfigContent(content, GARCON_PLUGIN_URL)).toThrow(expected);
  });
});

describe('OpenCode server plugin startup asset', () => {
  it('removes ambient identity and pure mode while preserving merged configuration', () => {
    const environment = buildOpenCodeServerEnv({
      KEEP_ME: 'yes',
      OPENCODE_CONFIG_CONTENT: '{ "formatter": false }',
      OPENCODE_PURE: '1',
      OPENCODE_SESSION_ID: 'ambient-session',
    }, GARCON_PLUGIN_URL);

    expect(environment).not.toHaveProperty('OPENCODE_PURE');
    expect(environment).not.toHaveProperty('OPENCODE_SESSION_ID');
    expect(environment.KEEP_ME).toBe('yes');
    expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT)).toEqual({
      formatter: false,
      plugin: [GARCON_PLUGIN_URL],
    });
  });

  it('removes case-insensitive ambient aliases on Windows', () => {
    const environment = buildOpenCodeServerEnv({
      Opencode_Config_Content: '{ "formatter": false }',
      opencode_pure: '1',
      opencode_session_id: 'ambient-session',
    }, GARCON_PLUGIN_URL, 'win32');

    expect(environment).not.toHaveProperty('Opencode_Config_Content');
    expect(environment).not.toHaveProperty('opencode_pure');
    expect(environment).not.toHaveProperty('opencode_session_id');
    expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT)).toEqual({
      formatter: false,
      plugin: [GARCON_PLUGIN_URL],
    });
  });

  it('resolves the checked-in plugin through an absolute file URL', () => {
    const pluginUrl = resolveSessionIdentityPluginUrl();

    expect(pluginUrl.startsWith('file://')).toBe(true);
    expect(existsSync(fileURLToPath(pluginUrl))).toBe(true);
  });

  it('includes the dependency-free plugin in the compiled pre-main artifact', async () => {
    const entrypoint = fileURLToPath(
      new URL('../../../build/prepare-compiled-runtime.ts', import.meta.url),
    );
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: 'bun',
      format: 'esm',
      naming: { asset: '[dir]/[name].[ext]' },
    });

    expect(result.success).toBe(true);
    const pluginOutput = result.outputs.find((output) => (
      output.kind === 'asset' && output.path.replaceAll('\\', '/').endsWith(
        '/garcon-session-identity.mjs',
      )
    ));
    expect(pluginOutput).toBeDefined();
    expect(await pluginOutput.text()).toBe(readFileSync(
      new URL('../garcon-session-identity.mjs', import.meta.url),
      'utf8',
    ));
  });
});
