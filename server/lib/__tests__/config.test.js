import { afterEach, describe, expect, it } from 'bun:test';
import path from 'path';
import {
  getHomeDirectoryPath,
  getPort,
  initializeServerConfig,
  resetServerConfigForTests,
  isAuthDisabled,
  isHttpCompressionEnabled,
} from '../../config.js';

const originalArgv = [...process.argv];
const originalPort = process.env.GARCON_PORT;
const originalMaxWsClients = process.env.GARCON_MAX_WS_CLIENTS;
const originalHttpCompression = process.env.GARCON_HTTP_COMPRESSION;
const originalDisableAuth = process.env.GARCON_DISABLE_AUTH;
const originalHome = process.env.HOME;
const configEnvironment = Object.fromEntries(['GARCON_CONFIG_DIR', 'GARCON_WORKSPACE', 'GARCON_WORKSPACE_DIR', 'GARCON_PROJECT_BASE_DIR', 'GARCON_BIND_ADDRESS'].map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of Object.entries(configEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerConfigForTests();
  process.argv = [...originalArgv];
  if (originalPort === undefined) {
    delete process.env.GARCON_PORT;
  } else {
    process.env.GARCON_PORT = originalPort;
  }
  if (originalMaxWsClients === undefined) {
    delete process.env.GARCON_MAX_WS_CLIENTS;
  } else {
    process.env.GARCON_MAX_WS_CLIENTS = originalMaxWsClients;
  }
  if (originalHttpCompression === undefined) {
    delete process.env.GARCON_HTTP_COMPRESSION;
  } else {
    process.env.GARCON_HTTP_COMPRESSION = originalHttpCompression;
  }
  if (originalDisableAuth === undefined) {
    delete process.env.GARCON_DISABLE_AUTH;
  } else {
    process.env.GARCON_DISABLE_AUTH = originalDisableAuth;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe('getPort', () => {
  it('rejects duplicate value flags and conflicting explicit workspace selectors', () => {
    process.argv = [...originalArgv, '--config-dir', '/first', '--config-dir=/second'];
    expect(() => initializeServerConfig()).toThrow('Option may be specified only once: --config-dir');
    process.argv = [...originalArgv, '--workspace', 'named', '--workspace-dir', '/explicit'];
    expect(() => initializeServerConfig()).toThrow('Choose only one of --workspace or --workspace-dir');
  });

  it('explicit flags override every matching environment default', () => {
    Object.assign(process.env, { GARCON_PORT: '9999', GARCON_BIND_ADDRESS: 'inherited', GARCON_CONFIG_DIR: '/inherited',
      GARCON_WORKSPACE_DIR: '/inherited/workspace', GARCON_WORKSPACE: 'inherited', GARCON_PROJECT_BASE_DIR: '/inherited/project', GARCON_DISABLE_AUTH: 'false' });
    process.argv = [...originalArgv, '--port', '0', '--bind-address', '0.0.0.0', '--config-dir=/explicit', '--workspace', 'work', '--project-base-dir', '/project', '--disable-auth'];
    expect(initializeServerConfig()).toMatchObject({ port: 0, bindAddress: '0.0.0.0', configDir: '/explicit',
      workspaceDir: '/explicit/workspace-work', workspaceName: 'work', projectBasePath: '/project', authDisabled: true });
  });

  it('explicit workspace paths override inherited names and empty roots are rejected', () => {
    Object.assign(process.env, { GARCON_CONFIG_DIR: '/inherited', GARCON_WORKSPACE_DIR: '/inherited/workspace', GARCON_WORKSPACE: 'inherited' });
    process.argv = [...originalArgv, '--workspace-dir', '/explicit/workspace'];
    expect(initializeServerConfig()).toMatchObject({ workspaceDir: '/explicit/workspace', workspaceName: null });
    process.argv = [...originalArgv, '--config-dir', ''];
    expect(() => initializeServerConfig()).toThrow('non-empty');
  });

  it('preserves env port 0 for OS-assigned binding', () => {
    process.env.GARCON_PORT = '0';
    process.argv = [...originalArgv];

    expect(getPort()).toBe(0);
  });

  it('preserves CLI port 0 for OS-assigned binding', () => {
    delete process.env.GARCON_PORT;
    process.argv = [...originalArgv, '--port', '0'];

    expect(getPort()).toBe(0);
  });

  it('rejects missing CLI port values', () => {
    delete process.env.GARCON_PORT;
    process.argv = [...originalArgv, '--port'];

    expect(() => getPort()).toThrow('--port requires a value');
  });

  it('rejects empty CLI port values', () => {
    delete process.env.GARCON_PORT;
    process.argv = [...originalArgv, '--port', ''];

    expect(() => getPort()).toThrow('Invalid --port value');
  });

  it('rejects non-integer ports', () => {
    process.env.GARCON_PORT = '3000.5';
    process.argv = [...originalArgv];

    expect(() => getPort()).toThrow('Invalid GARCON_PORT value');
  });

  it('freezes initialized config against later env changes', () => {
    process.env.GARCON_PORT = '9001';
    process.argv = [...originalArgv];

    const config = initializeServerConfig();
    process.env.GARCON_PORT = '9002';

    expect(Object.isFrozen(config)).toBe(true);
    expect(getPort()).toBe(9001);
  });

  it('validates websocket client limits during initialization', () => {
    process.env.GARCON_MAX_WS_CLIENTS = 'many';

    expect(() => initializeServerConfig()).toThrow('Invalid GARCON_MAX_WS_CLIENTS value');
  });

  it('parses the explicit carryover rollback startup flag', () => {
    process.argv = [...originalArgv, '--rollback-carryover-migration'];

    expect(initializeServerConfig().rollbackCarryOverMigration).toBe(true);
  });

  it('rejects negative websocket client limits during initialization', () => {
    process.env.GARCON_MAX_WS_CLIENTS = '-1';

    expect(() => initializeServerConfig()).toThrow('non-negative integer');
  });

});

describe('getHomeDirectoryPath', () => {
  it('resolves and freezes the server process HOME', () => {
    process.env.HOME = 'configured-home';
    const expected = path.resolve('configured-home');

    initializeServerConfig();
    process.env.HOME = 'changed-home';

    expect(getHomeDirectoryPath()).toBe(expected);
  });
});

describe('isAuthDisabled', () => {
  it('treats empty GARCON_DISABLE_AUTH as unset so the CLI flag can apply', () => {
    process.env.GARCON_DISABLE_AUTH = '';
    process.argv = [...originalArgv, '--disable-auth'];
    initializeServerConfig();

    expect(isAuthDisabled()).toBe(true);
  });
});

describe('isHttpCompressionEnabled', () => {
  it('defaults to enabled', () => {
    delete process.env.GARCON_HTTP_COMPRESSION;
    initializeServerConfig();
    expect(isHttpCompressionEnabled()).toBe(true);
  });

  it('disables on false-like env values', () => {
    process.env.GARCON_HTTP_COMPRESSION = 'false';
    initializeServerConfig();
    expect(isHttpCompressionEnabled()).toBe(false);
  });

  it('throws on invalid values', () => {
    process.env.GARCON_HTTP_COMPRESSION = 'maybe';
    expect(() => initializeServerConfig()).toThrow('Invalid GARCON_HTTP_COMPRESSION value');
  });
});
