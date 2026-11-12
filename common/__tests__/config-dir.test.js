import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveConfigDirectory, resolveHomeDirectory } from '../config-dir.js';

test('shared config resolution uses flags, then nonempty environment, then HOME default', () => {
  expect(resolveConfigDirectory('/explicit', { GARCON_CONFIG_DIR: '/env', HOME: '/home/test' })).toBe('/explicit');
  expect(resolveConfigDirectory(undefined, { GARCON_CONFIG_DIR: '/env' })).toBe('/env');
  expect(resolveConfigDirectory(undefined, { GARCON_CONFIG_DIR: '', HOME: '/home/test' })).toBe('/home/test/.garcon');
  expect(resolveConfigDirectory('relative', {})).toBe(path.resolve('relative'));
  expect(resolveConfigDirectory('/explicit', { GARCON_CONFIG_DIR: ' ' })).toBe('/explicit');
  expect(() => resolveConfigDirectory('', { GARCON_CONFIG_DIR: '/env' })).toThrow('non-empty');
  expect(() => resolveConfigDirectory(undefined, { GARCON_CONFIG_DIR: ' ' })).toThrow('non-empty');
});

test('Windows resolves the default root from the user profile, not HOME', () => {
  expect(resolveHomeDirectory('/msys/home/test', 'win32')).toBe(homedir());
  expect(resolveConfigDirectory(undefined, { HOME: '/msys/home/test' }, 'win32')).toBe(path.resolve(homedir(), '.garcon'));
  expect(resolveConfigDirectory(undefined, { GARCON_CONFIG_DIR: '/env', HOME: '/msys/home/test' }, 'win32')).toBe('/env');
  expect(resolveHomeDirectory('/home/test', 'linux')).toBe('/home/test');
  expect(resolveHomeDirectory('', 'darwin')).toBe(homedir());
});
