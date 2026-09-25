import { expect, test, spyOn } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitRuntime } from '../runtime.js';
import { runGit } from '../run.js';
import { withRepositoryMutation } from '../repository-coordination.js';
import { KeyedPromiseLock } from '../../../common/keyed-lock.js';
import { gitServiceError } from '../service-errors.js';

test('cancelled native dispatch is uncertain, while cancelled lock acquisition is definite', async () => {
  const directory = path.join(os.homedir(), 'tmp');
  await fs.mkdir(directory, { recursive: true });
  const projectPath = await fs.mkdtemp(path.join(directory, 'git-cancellation-'));
  const runtime = new GitRuntime({ executorId: 'local', instanceId: 'test', projectBasePath: projectPath, assertAvailable() {} });
  const release = Promise.withResolvers();
  let owner;
  let lock;
  let spawn;
  try {
    await runGit(projectPath, ['init', '-b', 'main']);
    const entered = Promise.withResolvers();
    owner = withRepositoryMutation(projectPath, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const queued = Promise.withResolvers();
    const originalLock = KeyedPromiseLock.prototype.runExclusive;
    lock = spyOn(KeyedPromiseLock.prototype, 'runExclusive').mockImplementation(function (key, operation, signal) {
      const result = originalLock.call(this, key, operation, signal);
      queued.resolve();
      return result;
    });
    const waitingAbort = new AbortController();
    const waiting = runtime.git.commitIndex({ projectPath, message: 'queued' }, { signal: waitingAbort.signal });
    const rejected = waiting.catch((error) => error);
    await queued.promise;
    waitingAbort.abort();
    expect(await rejected).toMatchObject({ code: 'GIT_TIMEOUT' });
    release.resolve();
    await owner;
    lock.mockRestore();

    const controller = new AbortController();
    const originalSpawn = Bun.spawn;
    spawn = spyOn(Bun, 'spawn').mockImplementation((args, options) => {
      if (args[0] !== 'git' || args[1] !== 'commit') return originalSpawn(args, options);
      const child = originalSpawn([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], options);
      queueMicrotask(() => controller.abort());
      return child;
    });
    await expect(runtime.git.commitIndex({ projectPath, message: 'interrupted' }, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
  } finally {
    release.resolve();
    await owner;
    lock?.mockRestore();
    spawn?.mockRestore();
    runtime.dispose();
    await fs.rm(projectPath, { recursive: true, force: true });
  }
});

test('read cancellation recognizes native timeout and abort flags', () => {
  for (const flag of ['timedOut', 'aborted']) {
    expect(gitServiceError(Object.assign(new Error('native process failed'), { [flag]: true })))
      .toMatchObject({ code: 'GIT_TIMEOUT' });
  }
});
