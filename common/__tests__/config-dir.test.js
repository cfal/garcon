import { expect, test } from 'bun:test';
import path from 'node:path';
import { resolveConfigDirectory } from '../config-dir.js';

test('shared config resolution uses flags, then nonempty environment, then HOME default', () => {
  expect(resolveConfigDirectory('/explicit', { GARCON_CONFIG_DIR: '/env', HOME: '/home/test' })).toBe('/explicit');
  expect(resolveConfigDirectory(undefined, { GARCON_CONFIG_DIR: '/env' })).toBe('/env');
  expect(resolveConfigDirectory(undefined, { GARCON_CONFIG_DIR: '', HOME: '/home/test' })).toBe('/home/test/.garcon');
  expect(resolveConfigDirectory('relative', {})).toBe(path.resolve('relative'));
  expect(resolveConfigDirectory('/explicit', { GARCON_CONFIG_DIR: ' ' })).toBe('/explicit');
  expect(() => resolveConfigDirectory('', { GARCON_CONFIG_DIR: '/env' })).toThrow('non-empty');
  expect(() => resolveConfigDirectory(undefined, { GARCON_CONFIG_DIR: ' ' })).toThrow('non-empty');
});
