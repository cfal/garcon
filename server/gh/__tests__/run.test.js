import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GhOutputLimitError, runGh } from '../run.js';

function textStream(value) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

describe('runGh', () => {
  let originalSpawn;
  let spawnMock;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    spawnMock = mock(() => ({
      stdout: textStream('ok\n'),
      stderr: textStream(''),
      exited: Promise.resolve(0),
      kill: mock(() => undefined),
    }));
    Bun.spawn = spawnMock;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  it('returns bounded command output', async () => {
    await expect(runGh('/repo', ['api', '/user'])).resolves.toEqual({
      stdout: 'ok\n',
      stderr: '',
    });
  });

  it('kills commands whose stdout exceeds its configured limit', async () => {
    const kill = mock(() => undefined);
    spawnMock.mockImplementation(() => ({
      stdout: textStream('output over limit'),
      stderr: textStream(''),
      exited: Promise.resolve(0),
      kill,
    }));

    await expect(
      runGh('/repo', ['api', '/user'], { maxStdoutBytes: 5 }),
    ).rejects.toBeInstanceOf(GhOutputLimitError);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('drains and truncates oversized stderr without failing a successful command', async () => {
    const kill = mock(() => undefined);
    spawnMock.mockImplementation(() => ({
      stdout: textStream(''),
      stderr: textStream('diagnostic over limit'),
      exited: Promise.resolve(0),
      kill,
    }));

    await expect(
      runGh('/repo', ['api', '/user'], { maxStderrBytes: 5 }),
    ).resolves.toEqual({ stdout: '', stderr: 'diagn' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('enforces limits while draining real subprocess pipes', async () => {
    Bun.spawn = originalSpawn;
    const commandDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-fake-gh-'));
    const fakeGhPath = path.join(commandDirectory, 'gh');
    await fs.writeFile(fakeGhPath, `#!/usr/bin/env bun
const output = 'x'.repeat(4 * 1024 * 1024);
const stream = process.argv.includes('stderr-overflow') ? process.stderr : process.stdout;
stream.write(output);
`, { mode: 0o755 });
    const commandPath = `${commandDirectory}${path.delimiter}${process.env.PATH ?? ''}`;

    try {
      await expect(runGh(process.cwd(), ['stdout-overflow'], {
        env: { PATH: commandPath },
        maxStdoutBytes: 1024,
        timeoutMs: 5_000,
      })).rejects.toMatchObject({ stream: 'stdout', maxBytes: 1024 });
      await expect(runGh(process.cwd(), ['stderr-overflow'], {
        env: { PATH: commandPath },
        maxStderrBytes: 1024,
        timeoutMs: 5_000,
      })).resolves.toEqual({ stdout: '', stderr: 'x'.repeat(1024) });
    } finally {
      await fs.rm(commandDirectory, { recursive: true, force: true });
    }
  });
});
