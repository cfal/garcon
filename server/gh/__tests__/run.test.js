import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

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

  it('kills commands whose stderr exceeds its configured limit', async () => {
    const kill = mock(() => undefined);
    spawnMock.mockImplementation(() => ({
      stdout: textStream(''),
      stderr: textStream('diagnostic over limit'),
      exited: Promise.resolve(1),
      kill,
    }));

    await expect(
      runGh('/repo', ['api', '/user'], { maxStderrBytes: 5 }),
    ).rejects.toMatchObject({
      stream: 'stderr',
      maxBytes: 5,
    });
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
