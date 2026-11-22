import { expect, test } from 'bun:test';
import path from 'node:path';
import { assertCompatibleCodex, resolveCodexCli } from '../cli.js';
import { CodexAppServerClient } from '../client.js';

test('selects the executor override or its native PATH command without invoking a shell', () => {
  expect(resolveCodexCli({}, 'linux')).toEqual({ command: 'codex', source: 'path' });
  expect(resolveCodexCli({ GARCON_CODEX_CLI: ' ' }, 'win32')).toEqual({ command: 'codex.exe', source: 'path' });
  expect(resolveCodexCli({ GARCON_CODEX_CLI: ' C:\\Program Files\\codex.exe ' }, 'win32'))
    .toEqual({ command: 'C:\\Program Files\\codex.exe', source: 'env' });
  expect(resolveCodexCli({ GARCON_CODEX_CLI: './tools/selected codex' }).command)
    .toBe(path.resolve('tools/selected codex'));
  expect(resolveCodexCli({ GARCON_CODEX_CLI: 'codex-preview' }).command).toBe('codex-preview');
});

test('checks the app-server version, not the Garcon version later in its user agent', () => {
  for (const version of ['0.171.0', '0.172.0', '1.0.0']) {
    expect(() => assertCompatibleCodex(`garcon/${version} (linux) terminal (garcon; 0.1.0)`)).not.toThrow();
  }
  for (const agent of ['garcon/0.9.0 (garcon; 1.9.0)', 'unknown']) {
    expect(() => assertCompatibleCodex(agent)).toThrow('0.171.0');
  }
});

test('an incompatible handshake closes the CLI before connect rejects', async () => {
  const client = new CodexAppServerClient({
    spawn: () => Bun.spawn([process.execPath, '-e', `
      for await (const line of console) {
        if (!line) continue;
        const { id, method } = JSON.parse(line);
        if (method !== 'initialize') process.exit(1);
        console.log(JSON.stringify({ id, result: { userAgent: 'codex/0.170.9' } }));
      }
    `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }),
  });
  const exitCodes: number[] = [];
  client.on('exit', (code: number) => { exitCodes.push(code); });
  try {
    await expect(client.connect()).rejects.toThrow('0.171.0');
    expect(exitCodes).toEqual([0]);
  } finally {
    await client.shutdown();
  }
});
