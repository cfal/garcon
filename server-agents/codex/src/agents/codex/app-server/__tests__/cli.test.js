import { describe, expect, it } from 'bun:test';
import { bundledCodexCliPath, resolveCodexCli } from '../cli.js';

function packageResolver(packages) {
  const calls = [];
  const resolve = (specifier, parentPath) => {
    calls.push([specifier, parentPath]);
    const resolved = packages[specifier];
    if (!resolved) throw new Error(`Cannot find module '${specifier}'`);
    return resolved;
  };
  return { resolve, calls };
}

describe('bundledCodexCliPath', () => {
  it('resolves the Windows native executable through the launcher package', () => {
    const { resolve, calls } = packageResolver({
      '@openai/codex/package.json': '/repo/node_modules/@openai/codex/package.json',
      '@openai/codex-win32-x64/package.json': '/repo/node_modules/@openai/codex-win32-x64/package.json',
    });

    expect(bundledCodexCliPath('win32', 'x64', resolve)).toBe(
      '/repo/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
    );
    expect(calls[1]).toEqual([
      '@openai/codex-win32-x64/package.json',
      '/repo/node_modules/@openai/codex/package.json',
    ]);
  });

  it('resolves the POSIX native executable without an extension', () => {
    const { resolve } = packageResolver({
      '@openai/codex/package.json': '/repo/node_modules/@openai/codex/package.json',
      '@openai/codex-darwin-arm64/package.json': '/repo/node_modules/@openai/codex-darwin-arm64/package.json',
    });

    expect(bundledCodexCliPath('darwin', 'arm64', resolve)).toBe(
      '/repo/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    );
  });

  it('returns null for unsupported targets and missing platform packages', () => {
    const { resolve } = packageResolver({
      '@openai/codex/package.json': '/repo/node_modules/@openai/codex/package.json',
    });

    expect(bundledCodexCliPath('freebsd', 'x64', resolve)).toBeNull();
    expect(bundledCodexCliPath('linux', 'x64', resolve)).toBeNull();
  });

  it('finds the installed native executable for this platform', async () => {
    const resolved = await resolveCodexCli({ env: {} });

    expect(resolved).toEqual({ command: bundledCodexCliPath(), source: 'bundled' });
  });
});

describe('resolveCodexCli', () => {
  it('prefers the GARCON_CODEX_CLI override', async () => {
    await expect(resolveCodexCli({ env: { GARCON_CODEX_CLI: ' C:\\codex\\codex.exe ' } })).resolves.toEqual({
      command: 'C:\\codex\\codex.exe',
      source: 'env',
    });
  });

  it('falls back to PATH when no bundled executable is available', async () => {
    await expect(resolveCodexCli({ env: {}, bundledCommand: null })).resolves.toEqual({ command: 'codex', source: 'path' });
    await expect(resolveCodexCli({
      env: {},
      bundledCommand: '/missing/codex',
      isExecutable: async () => false,
    })).resolves.toEqual({ command: 'codex', source: 'path' });
  });
});
