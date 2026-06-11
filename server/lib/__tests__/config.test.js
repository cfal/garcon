import { afterEach, describe, expect, it } from 'bun:test';
import { getPort } from '../../config.js';

const originalArgv = [...process.argv];
const originalPort = process.env.GARCON_PORT;

afterEach(() => {
  process.argv = [...originalArgv];
  if (originalPort === undefined) {
    delete process.env.GARCON_PORT;
  } else {
    process.env.GARCON_PORT = originalPort;
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
});
