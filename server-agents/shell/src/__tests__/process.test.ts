import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHELL_FAMILIES } from '../catalog.js';
import { executeShell } from '../process.js';
import { parseSubmission } from '../source.js';

it('parses only executor-owned Markdown prefixes without trimming source', () => {
  expect(parseSubmission('/md\n  echo text\n')).toEqual({ source: '  echo text\n', format: 'markdown' });
  expect(parseSubmission('/markdown echo text ')).toEqual({ source: 'echo text ', format: 'markdown' });
  for (const source of ['/mdtool', '/usr/bin/true', 'command /md', '  echo text\n']) {
    expect(parseSubmission(source)).toEqual({ source, format: 'plain' });
  }
  expect(() => parseSubmission('/md')).toThrow();
  for (const json of ['"echo \\ud800"', '"/md echo \\udfff"']) {
    expect(() => parseSubmission(JSON.parse(json))).toThrow('well-formed Unicode');
  }
  expect(parseSubmission('printf "\u{1f600}"').source).toBe('printf "\u{1f600}"');
});

for (const family of SHELL_FAMILIES) {
  const executable = Bun.which(family);
  describe.skipIf(!executable)(`fresh ${family} command`, () => {
    let directory: string;
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "garcon-shell-'test-"));
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
      const result = await run("cd 'space and\nnewline'\nprintf output\nprintf error >&2");
      expect(result.stdout.endsWith('output')).toBe(true);
      expect(result.stderr).toContain('error');
      expect(result.exitCode).toBe(0);
      expect(result.cwd).toEqual({ kind: 'reported', path: join(directory, 'space and\nnewline') });
      expect(result.complete).toBe(true);
    });
    it('preserves nonzero status and reports cwd even on failure', async () => {
      const result = await run('false');
      expect(result.exitCode).toBe(1);
      expect(result.cwd).toEqual({ kind: 'reported', path: directory });
    });
    if (family === 'sh' || family === 'bash' || family === 'zsh') {
      it('does not expose wrapper arguments to submitted source', async () => {
        const result = await run('printf "%s|%s|%s" "$#" "${1-unset}" "${2-unset}"');
        expect(result.stdout).toEndWith('0|unset|unset');
        expect(result.exitCode).toBe(0);
      });
    }
    it('retains unknown cwd when exit bypasses the footer', async () => {
      const result = await run("exec /bin/sh -c 'exit 7'");
      expect(result.exitCode).toBe(7);
      expect(result.cwd.kind).toBe('unavailable');
    });
    it('drains fast large output before completion', async () => {
      const result = await run("head -c 262144 /dev/zero | tr '\\0' x\nhead -c 262144 /dev/zero | tr '\\0' y >&2");
      expect(result.stdout.endsWith('x'.repeat(262144))).toBe(true);
      expect(result.stderr.endsWith('y'.repeat(262144))).toBe(true);
      expect(result.complete).toBe(true);
    });
    it('stops a command blocked on ordinary stdin', async () => {
      const cancellation = new AbortController();
      const timer = setTimeout(() => cancellation.abort(), 1000);
      try {
        const result = await run('cat', cancellation.signal);
        expect(result.interrupted).toBe(true);
      } finally { clearTimeout(timer); }
    }, 10_000);

    it('restores cwd after the usual profile changes it and captures profile output', async () => {
      const profiles = { sh: 'profile', bash: '.bashrc', zsh: '.zshrc', fish: 'fish/config.fish' };
      const file = join(directory, profiles[family]);
      await mkdir(join(directory, 'fish'), { recursive: true });
      await writeFile(file, 'cd /\nprintf startup\n');
      try {
        const result = await run('printf command');
        expect(result.stdout.endsWith('startupcommand')).toBe(true);
        expect(result.cwd).toEqual({ kind: 'reported', path: directory });
      } finally { await rm(file, { force: true }); }
    });

    it('bounds output-sink stalls and prevents late callbacks from continuing capture', async () => {
      const gate = Promise.withResolvers<void>();
      let calls = 0;
      try {
        const result = await run('printf output', undefined, async () => {
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
      await expect(run('printf output', undefined,
        async () => { throw new Error('Synthetic storage failure'); })).rejects.toThrow('Synthetic storage failure');
    });

    if (family === 'sh') {
      it('preserves a trailing backslash without adding a newline', async () => {
        const result = await run('printf x\\');
        expect(result.stdout).toBe('x\\');
      });

      it('fails sourced syntax errors without falling back to interactive stdin', async () => {
        const result = await run('echo )', AbortSignal.timeout(2000));
        expect(result.interrupted).toBe(false);
        expect(result.exitCode).not.toBe(0);
      });

      it('decodes split UTF-8 independently and preserves terminal controls as inert text', async () => {
        const result = await run("printf '\\342'; sleep 0.02; printf '\\202\\254\\033[31mred\\033[0m\\r\\b'");
        expect(result.stdout).toBe('\u20ac\x1b[31mred\x1b[0m\r\b');
        expect(result.complete).toBe(true);
      });

      it('continues execution beyond the former output limit', async () => {
        const bytes = 17 * 1024 * 1024;
        const result = await run(`head -c ${bytes} /dev/zero | tr '\\0' x; printf finished`);
        expect(result.stdout.length).toBe(bytes + 'finished'.length);
        expect(result.stdout.endsWith('finished')).toBe(true);
        expect(result.complete).toBe(true);
        expect(result.exitCode).toBe(0);
      });

      it('bounds background-held pipes and marks incomplete capture', async () => {
        const result = await run('sleep 60 &\nprintf foreground');
        expect(result.stdout).toBe('foreground');
        expect(result.complete).toBe(false);
      });
    }

    if (family === 'bash') {
      it.each([
        'rm "$report"; mkfifo "$report"',
        'rm "$report"; ln -s /dev/null "$report"',
        'rm "$report"',
        ': > "$report"',
        'printf relative > "$report"',
        'printf "\\377" > "$report"',
        'head -c 65538 /dev/zero > "$report"',
      ])('distinguishes an invalid cwd report from a missing footer: %s', async (replace) => {
        const result = await run('report="$(dirname "${BASH_SOURCE[0]}")/cwd"; ' + replace + '; exit 0');
        expect(result.exitCode).toBe(0);
        expect(result.cwd.kind).toBe('invalid');
        expect(result.complete).toBe(true);
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
