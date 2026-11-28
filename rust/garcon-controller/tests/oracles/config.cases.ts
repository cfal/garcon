import { expect, test } from 'bun:test';
import { configFor } from './config.ts';

test('explicit flags override matching environment defaults', () => {
  expect(configFor(
    ['--port', '0', '--bind-address', '0.0.0.0', '--config-dir=/explicit', '--workspace', 'work', '--project-base-dir', '/project', '--disable-auth'],
    {
      GARCON_PORT: '9999', GARCON_BIND_ADDRESS: 'inherited', GARCON_CONFIG_DIR: '/inherited',
      GARCON_WORKSPACE_DIR: '/inherited/workspace', GARCON_WORKSPACE: 'inherited',
      GARCON_PROJECT_BASE_DIR: '/inherited/project', GARCON_DISABLE_AUTH: 'false',
    },
  )).toMatchObject({
    port: 0, bindAddress: '0.0.0.0', configDir: '/explicit', workspaceDir: '/explicit/workspace-work',
    workspaceName: 'work', projectBasePath: '/project', authDisabled: true,
  });
});

test('the base path and public URL are canonical and agree', () => {
  expect(configFor(['--base-path=/prefix/', '--public-url', 'https://override.test/prefix'], {}))
    .toMatchObject({ basePath: '/prefix', publicUrl: 'https://override.test/prefix/' });
  expect(() => configFor(['--base-path=/a//b'], {})).toThrow('Invalid base path');
});

test('the published runtime URL accepts only HTTP origins', () => {
  expect(configFor(['--runtime-origin=http://LocalHost:80'], {}).runtimeOrigin).toBe('http://localhost');
  expect(() => configFor(['--runtime-origin', 'http://host.test/prefix'], {})).toThrow('--runtime-origin');
});

test('env limits and proxy settings parse separately', () => {
  expect(configFor([], {
    GARCON_PORT: '0', GARCON_MAX_WS_CLIENTS: ' 128 ', GARCON_HTTP_COMPRESSION: 'false',
    GARCON_TRUST_PROXY: 'yes', GARCON_WS_BACKPRESSURE_LIMIT: '2048', HOME: 'configured-home',
  })).toMatchObject({
    port: 0, maxWsClients: 128, httpCompressionEnabled: false, trustProxyEnabled: true,
    wsBackpressureLimit: 2048, homeDirectoryPath: '/configured-home',
  });
  expect(() => configFor([], { GARCON_MAX_WS_CLIENTS: '-1' })).toThrow('non-negative integer');
});
