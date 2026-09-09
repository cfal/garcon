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
const tlsEnvNames = ['GARCON_TLS_CERT', 'GARCON_TLS_KEY', 'GARCON_TLS_CA'];
const originalTlsEnv = tlsEnvNames.map((name) => process.env[name]);

afterEach(() => {
  resetServerConfigForTests();
  process.argv = [...originalArgv];
  for (const [index, name] of tlsEnvNames.entries()) {
    if (originalTlsEnv[index] === undefined) delete process.env[name];
    else process.env[name] = originalTlsEnv[index];
  }
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

describe('TLS configuration', () => {
  function configure(args = []) {
    for (const name of tlsEnvNames) delete process.env[name];
    process.argv = [...originalArgv, ...args];
  }

  it('keeps ordinary startup plaintext without TLS configuration', () => {
    configure();
    expect(initializeServerConfig().tls).toBeNull();
  });

  it('requires both files and rejects missing or empty flag values', () => {
    for (const args of [['--tls-cert', 'cert.pem'], ['--tls-key', 'key.pem'],
      ['--tls-cert'], ['--tls-key'], ['--tls-cert', '', '--tls-key', 'key.pem'],
      ['--tls-cert', '--tls-key', 'key.pem']]) {
      configure(args);
      expect(() => initializeServerConfig()).toThrow();
    }
  });

  it('resolves configured paths and gives environment settings precedence', () => {
    configure(['--tls-cert', 'cert.pem', '--tls-key', 'key.pem']);
    expect(initializeServerConfig().tls).toEqual({
      certificatePath: path.resolve('cert.pem'), keyPath: path.resolve('key.pem'),
    });
    process.env.GARCON_TLS_CERT = 'env.pem';
    process.env.GARCON_TLS_KEY = 'env.key';
    expect(initializeServerConfig().tls).toEqual({
      certificatePath: path.resolve('env.pem'), keyPath: path.resolve('env.key'),
    });
  });

  it('accepts explicit private CLI trust with the same environment precedence', () => {
    configure(['--tls-cert', 'cert.pem', '--tls-key', 'key.pem', '--tls-ca', 'root.pem']);
    expect(initializeServerConfig().tls.caPath).toBe(path.resolve('root.pem'));
    process.env.GARCON_TLS_CA = 'environment-root.pem';
    expect(initializeServerConfig().tls.caPath).toBe(path.resolve('environment-root.pem'));
  });

  it('rejects unused, empty and option-valued CA configuration', () => {
    for (const args of [
      ['--tls-ca', 'root.pem'], ['--tls-ca'],
      ['--tls-cert', 'cert.pem', '--tls-key', 'key.pem', '--tls-ca', ''],
      ['--tls-cert', 'cert.pem', '--tls-key', 'key.pem', '--tls-ca', '--port', '0'],
    ]) {
      configure(args);
      expect(() => initializeServerConfig()).toThrow();
    }
    configure(['--tls-cert', 'cert.pem', '--tls-key', 'key.pem', '--tls-ca', 'root.pem',
      '--workspace-dir', '/synthetic/workspace']);
    expect(() => initializeServerConfig()).toThrow('requires a named workspace');
    configure(['--tls-cert', 'cert.pem', '--tls-key', 'key.pem']);
    process.env.GARCON_TLS_CA = '   ';
    expect(() => initializeServerConfig()).toThrow('TLS CA path must not be empty');
  });
});

describe('getPort', () => {
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
