import { expect, test } from 'bun:test';
import { assertCompatibleCodex, resolveCodexCli } from '../cli.js';

test('selects the executor override or its native PATH command without invoking a shell', () => {
  expect(resolveCodexCli({}, 'linux')).toEqual({ command: 'codex', source: 'path' });
  expect(resolveCodexCli({ GARCON_CODEX_CLI: ' ' }, 'win32')).toEqual({ command: 'codex.exe', source: 'path' });
  expect(resolveCodexCli({ GARCON_CODEX_CLI: ' C:\\Program Files\\codex.exe ' }, 'win32'))
    .toEqual({ command: 'C:\\Program Files\\codex.exe', source: 'env' });
});

test('checks the app-server version, not the Garcon version later in its user agent', () => {
  for (const version of ['0.171.0', '0.172.0', '1.0.0']) {
    expect(() => assertCompatibleCodex(`garcon/${version} (linux) terminal (garcon; 0.1.0)`)).not.toThrow();
  }
  for (const agent of ['garcon/0.9.0 (garcon; 1.9.0)', 'unknown']) {
    expect(() => assertCompatibleCodex(agent)).toThrow('0.171.0');
  }
});
