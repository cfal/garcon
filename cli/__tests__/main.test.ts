import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../main.js';
import type { CliOutput } from '../output.js';

function capturedOutput(): { output: CliOutput; diagnostics: string[] } {
  const diagnostics: string[] = [];
  return {
    diagnostics,
    output: {
      accepted() {},
      completed() {},
      listing() {},
      diagnostic(message) { diagnostics.push(message); },
    },
  };
}

describe('main', () => {
  test('interrupts a pending stdin read before runtime discovery', async () => {
    const controller = new AbortController();
    const capture = capturedOutput();
    const result = main([
      '--agent', 'codex',
      '--model', 'gpt-5.4',
      '-',
    ], {
      signal: controller.signal,
      readStdin: () => new Promise(() => undefined),
      output: capture.output,
    });

    controller.abort(new Error('terminal interrupted'));

    await expect(result).resolves.toBe(130);
    expect(capture.diagnostics).toEqual([
      'terminal interrupted; no Garcon agent was stopped',
    ]);
  });

  test('rejects a file passed as the project directory before discovery', async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-cli-main-'));
    const file = path.join(temporaryDirectory, 'project.txt');
    await fs.writeFile(file, 'not a directory');
    const capture = capturedOutput();
    try {
      const exitCode = await main([
        '--cwd', file,
        '--agent', 'codex',
        '--model', 'gpt-5.4',
        'Review',
      ], { output: capture.output });

      expect(exitCode).toBe(2);
      expect(capture.diagnostics[0]).toContain('--cwd must identify an existing directory');
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('exits after SIGINT while a stdin pipe remains open', async () => {
    const cliEntry = path.join(import.meta.dir, '..', 'main.ts');
    const child = Bun.spawn([
      process.execPath,
      cliEntry,
      '--agent', 'codex',
      '--model', 'gpt-5.4',
      '-',
    ], {
      cwd: path.join(import.meta.dir, '..', '..'),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('CLI did not exit after SIGINT')), 3_000);
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      child.kill('SIGINT');

      await expect(Promise.race([child.exited, timeout])).resolves.toBe(130);
      expect(await new Response(child.stderr).text()).toContain(
        'terminal interrupted; no Garcon agent was stopped',
      );
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
