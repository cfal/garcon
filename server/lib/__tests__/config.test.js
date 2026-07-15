import { afterEach, describe, expect, it } from 'bun:test';
import {
  getPort,
  getReservedChatWsSlots,
  initializeServerConfig,
  resetServerConfigForTests,
  isAuthDisabled,
  isHttpCompressionEnabled,
} from '../../config.js';

const originalArgv = [...process.argv];
const originalPort = process.env.GARCON_PORT;
const originalMaxWsClients = process.env.GARCON_MAX_WS_CLIENTS;
const originalReservedChatWsSlots = process.env.GARCON_RESERVED_CHAT_WS_SLOTS;
const originalHttpCompression = process.env.GARCON_HTTP_COMPRESSION;
const originalDisableAuth = process.env.GARCON_DISABLE_AUTH;

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
  if (originalReservedChatWsSlots === undefined) {
    delete process.env.GARCON_RESERVED_CHAT_WS_SLOTS;
  } else {
    process.env.GARCON_RESERVED_CHAT_WS_SLOTS = originalReservedChatWsSlots;
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

  it('rejects negative websocket client limits during initialization', () => {
    process.env.GARCON_MAX_WS_CLIENTS = '-1';

    expect(() => initializeServerConfig()).toThrow('non-negative integer');
  });

  it('derives and validates reserved Chat websocket slots', () => {
    process.env.GARCON_MAX_WS_CLIENTS = '8';
    delete process.env.GARCON_RESERVED_CHAT_WS_SLOTS;
    initializeServerConfig();
    expect(getReservedChatWsSlots()).toBe(2);

    resetServerConfigForTests();
    process.env.GARCON_RESERVED_CHAT_WS_SLOTS = '3';
    initializeServerConfig();
    expect(getReservedChatWsSlots()).toBe(3);
  });

  it('reserves the only websocket slot for Chat', () => {
    process.env.GARCON_MAX_WS_CLIENTS = '1';
    delete process.env.GARCON_RESERVED_CHAT_WS_SLOTS;
    initializeServerConfig();
    expect(getReservedChatWsSlots()).toBe(1);
  });

  it('rejects invalid explicit Chat websocket reservations', () => {
    process.env.GARCON_MAX_WS_CLIENTS = '4';
    process.env.GARCON_RESERVED_CHAT_WS_SLOTS = '4';
    expect(() => initializeServerConfig()).toThrow('GARCON_RESERVED_CHAT_WS_SLOTS');
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
