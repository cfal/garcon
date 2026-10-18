import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GhOutputLimitError, runGh, runGhMutation } from '../run.js';

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

  it('keeps an undispatched mutation launch failure definite', async () => {
    spawnMock.mockImplementation(() => { throw new Error('Executable not found'); });
    await expect(runGhMutation('/repo', ['api', '--method', 'POST'])).rejects.toThrow('not installed');
  });

  it('reports an unconfirmed mutation exit as unknown', async () => {
    spawnMock.mockImplementation(() => ({
      stdout: textStream(''), stderr: textStream('connection reset by peer'), exited: Promise.resolve(1), kill: mock(() => undefined),
    }));
    await expect(runGhMutation('/repo', ['api', '--method', 'POST'])).rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
  });

  for (const status of [400, 401, 403, 404, 422, 429, 408, 500, 502]) {
    it(`classifies HTTP ${status} without treating uncertain responses as rejections`, async () => {
      spawnMock.mockImplementation(() => ({ stdout: textStream(''), stderr: textStream(`gh: Request failed (HTTP ${status})`), exited: Promise.resolve(1), kill: mock(() => undefined) }));
      await expect(runGhMutation('/repo', ['api', '--method', 'POST'])).rejects.toMatchObject({
        code: status < 500 && status !== 408 ? 'GH_MUTATION_REJECTED' : 'GIT_MUTATION_OUTCOME_UNKNOWN',
      });
    });
  }

  it('preserves an unknown mutation outcome when its reply exceeds the output limit', async () => {
    await expect(runGhMutation('/repo', ['api', '--method', 'POST'], { maxStdoutBytes: 1 }))
      .rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
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
