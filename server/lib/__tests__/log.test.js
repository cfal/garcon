import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createLogger } from '../log.ts';

const originalDebug = console.debug;
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;
const originalLogLevel = process.env.GARCON_LOG_LEVEL;

afterEach(() => {
  console.debug = originalDebug;
  console.info = originalInfo;
  console.warn = originalWarn;
  console.error = originalError;
  if (originalLogLevel === undefined) {
    delete process.env.GARCON_LOG_LEVEL;
  } else {
    process.env.GARCON_LOG_LEVEL = originalLogLevel;
  }
});

describe('createLogger', () => {
  it('filters below the configured log level and prefixes messages', () => {
    process.env.GARCON_LOG_LEVEL = 'warn';
    console.info = mock(() => undefined);
    console.warn = mock(() => undefined);

    const logger = createLogger('test');
    logger.info('hidden');
    logger.warn('visible');

    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith('[test]', 'visible');
  });

  it('supports debug logging when enabled', () => {
    process.env.GARCON_LOG_LEVEL = 'debug';
    console.debug = mock(() => undefined);

    createLogger('debug-scope').debug('details');

    expect(console.debug).toHaveBeenCalledWith('[debug-scope]', 'details');
  });
});
