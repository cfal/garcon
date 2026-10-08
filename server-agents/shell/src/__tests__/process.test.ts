import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHELL_FAMILIES } from '../catalog.js';
import { COMMAND_OUTPUT_LIMIT, executeShell } from '../process.js';
import { parseSubmission } from '../source.js';

it('parses only executor-owned Markdown prefixes without trimming source', () => {
  expect(parseSubmission('/md\n  echo text\n')).toEqual({ source: '  echo text\n', format: 'markdown' });
  expect(parseSubmission('/markdown echo text ')).toEqual({ source: 'echo text ', format: 'markdown' });
  for (const source of ['/mdtool', '/usr/bin/true', 'command /md', '  echo text\n']) {
    expect(parseSubmission(source)).toEqual({ source, format: 'plain' });
  }
  expect(() => parseSubmission('/md')).toThrow();
});

for (const family of SHELL_FAMILIES) {
  const executable = Bun.which(family);
  describe.skipIf(!executable)(`fresh ${family} command`, () => {
    let directory: string;
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'garcon-shell-test-'));
      await mkdir(join(directory, 'space and\nnewline'));
    });
    afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
    async function run(source: string, signal = new AbortController().signal, output?: () => Promise<void>) {
      let stdout = '';
      let stderr = '';
      const result = await executeShell({
        family, executable: executable!, source, cwd: directory, temporaryRoot: directory, signal,
        environment: { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory, ZDOTDIR: directory, ENV: join(directory, 'profile'), TERM: 'dumb' },
        async output(channel, text) { if (channel === 'stdout') stdout += text; else stderr += text; await output?.(); },
      });
      return { ...result, stdout, stderr };
    }
    it('separates streams and observes cwd after same-scope execution', async () => {
      const result = await run(family === 'pwsh'
        ? 'Set-Location "space and`nnewline"; [Console]::Out.Write("output"); [Console]::Error.Write("error")'
        : "cd 'space and\nnewline'\nprintf output\nprintf error >&2");
      expect(result.stdout.endsWith('output')).toBe(true);
      expect(result.stderr).toContain('error');
      expect(result.exitCode).toBe(0);
      expect(result.cwd).toEqual({ kind: 'reported', path: join(directory, 'space and\nnewline') });
      expect(result.complete).toBe(true);
    });
    it('preserves nonzero status and reports cwd even on failure', async () => {
      const result = await run(family === 'pwsh' ? "& /bin/sh -c 'exit 7'" : 'false');
      expect(result.exitCode).toBe(family === 'pwsh' ? 7 : 1);
      expect(result.cwd).toEqual({ kind: 'reported', path: directory });
    });
    it('retains unknown cwd when exit bypasses the footer', async () => {
      const result = await run('exit 7');
      expect(result.exitCode).toBe(7);
      expect(result.cwd.kind).toBe('unavailable');
    });
    it('drains fast large output before completion', async () => {
      const result = await run(family === 'pwsh'
        ? "[Console]::Out.Write(('x' * 262144)); [Console]::Error.Write(('y' * 262144))"
        : "head -c 262144 /dev/zero | tr '\\0' x\nhead -c 262144 /dev/zero | tr '\\0' y >&2");
      expect(result.stdout.endsWith('x'.repeat(262144))).toBe(true);
      expect(result.stderr.endsWith('y'.repeat(262144))).toBe(true);
      expect(result.complete).toBe(true);
    });
    it('stops a command blocked on ordinary stdin', async () => {
      const cancellation = new AbortController();
      const timer = setTimeout(() => cancellation.abort(), 1000);
      try {
        const result = await run(family === 'pwsh' ? '[Console]::ReadLine()' : 'cat', cancellation.signal);
        expect(result.interrupted).toBe(true);
      } finally { clearTimeout(timer); }
    }, 10_000);

    it('restores cwd after the usual profile changes it and captures profile output', async () => {
      const file = join(directory, family === 'pwsh' ? 'powershell/profile.ps1'
        : family === 'fish' ? 'fish/config.fish' : family === 'bash' ? '.bashrc' : family === 'zsh' ? '.zshrc' : 'profile');
      await mkdir(join(directory, family === 'pwsh' ? 'powershell' : 'fish'), { recursive: true });
      await writeFile(file, family === 'pwsh' ? 'Set-Location /; [Console]::Out.Write("startup")'
        : 'cd /\nprintf startup\n');
      try {
        const result = await run(family === 'pwsh' ? '[Console]::Out.Write("command")' : 'printf command');
        expect(result.stdout.endsWith('startupcommand')).toBe(true);
        expect(result.cwd).toEqual({ kind: 'reported', path: directory });
      } finally { await rm(file, { force: true }); }
    });

    it('bounds output-sink stalls and prevents late callbacks from continuing capture', async () => {
      const gate = Promise.withResolvers<void>();
      let calls = 0;
      try {
        const result = await run(family === 'pwsh' ? '[Console]::Out.Write("output")' : 'printf output', undefined, async () => {
          calls++; await gate.promise;
        });
        expect(result.complete).toBe(false);
        const before = calls;
        gate.resolve();
        await Bun.sleep(10);
        expect(calls).toBe(before);
      } finally { gate.resolve(); }
    }, 10_000);

    it('fails on output persistence rejection instead of reporting success', async () => {
      await expect(run(family === 'pwsh' ? '[Console]::Out.Write("output")' : 'printf output', undefined,
        async () => { throw new Error('Synthetic storage failure'); })).rejects.toThrow('Synthetic storage failure');
    });

    if (family === 'sh') {
      it('decodes split UTF-8 independently and preserves terminal controls as inert text', async () => {
        const result = await run("printf '\\342'; sleep 0.02; printf '\\202\\254\\033[31mred\\033[0m\\r\\b'");
        expect(result.stdout).toBe('\u20ac\x1b[31mred\x1b[0m\r\b');
        expect(result.complete).toBe(true);
      });

      it('stops capture at the byte limit instead of silently reporting complete output', async () => {
        const result = await run(`head -c ${COMMAND_OUTPUT_LIMIT + 1} /dev/zero | tr '\\0' x`);
        expect(result.stdout.length).toBeLessThanOrEqual(COMMAND_OUTPUT_LIMIT);
        expect(result.complete).toBe(false);
      });

      it('rejects a FIFO cwd report without blocking', async () => {
        const result = await run('report="$(dirname "$1")/cwd"; rm "$report"; mkfifo "$report"; exit 0');
        expect(result.exitCode).toBe(0);
        expect(result.cwd.kind).toBe('unavailable');
      });

      it('bounds background-held pipes and marks incomplete capture', async () => {
        const result = await run('sleep 60 &\nprintf foreground');
        expect(result.stdout).toBe('foreground');
        expect(result.complete).toBe(false);
      });
    }

    if (family === 'pwsh') {
      it('preserves using and param headers and treats return as successful without a cwd report', async () => {
        const result = await run("using namespace System.Text\nparam()\n[Console]::Out.Write([StringBuilder]::new('header').ToString())\nreturn");
        expect(result.stdout).toBe('header');
        expect(result.exitCode).toBe(0);
        expect(result.cwd.kind).toBe('unavailable');
      });
    }

    if (family === 'bash' || family === 'fish') {
      it('disables profile job control so Stop reaches foreground children', async () => {
        const file = join(directory, family === 'bash' ? '.bashrc' : 'fish/config.fish');
        await mkdir(join(directory, 'fish'), { recursive: true });
        await writeFile(file, family === 'bash' ? 'set -m\n' : 'status job-control full\n');
        const cancellation = new AbortController();
        const command = run("/bin/sh -c 'echo $$ > worker.pid; exec sleep 60'", cancellation.signal);
        let pid: number | undefined;
        try {
          for (let count = 0; count < 300; count++) {
            try { pid = Number(await readFile(join(directory, 'worker.pid'), 'utf8')); break; } catch { await Bun.sleep(10); }
          }
          expect(pid).toBeGreaterThan(0);
          cancellation.abort();
          expect((await command).interrupted).toBe(true);
          expect(() => process.kill(pid!, 0)).toThrow();
        } finally {
          cancellation.abort(); await command;
          await rm(file, { force: true });
          await rm(join(directory, 'worker.pid'), { force: true });
        }
      }, 10_000);
    }
  });
}
