import { afterEach, describe, expect, it } from 'bun:test';
import { getPort, initializeServerConfig, resetServerConfigForTests } from '../../config.js';

const originalArgv = [...process.argv];
const originalPort = process.env.GARCON_PORT;
const originalMaxWsClients = process.env.GARCON_MAX_WS_CLIENTS;

afterEach(() => {
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
});
