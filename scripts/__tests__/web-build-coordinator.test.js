import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  acquireWebBuildLock,
  ensureWebBuild,
  WebBuildProcessError,
} from '../web-build-coordinator.js';
import { assertWebBuildArguments } from '../build-web.js';
import { isWebBuildCurrent, recordWebBuild } from '../web-build-cache.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-web-build-coordinator-'));
  temporaryDirectories.push(root);
  const input = path.join(root, 'input');
  const buildDir = path.join(root, 'build');
  const markerPath = path.join(buildDir, '.marker');
  const lockRoot = path.join(root, 'web');
  const lockPath = path.join(lockRoot, '.garcon-web-build.lock');
  await fs.mkdir(input);
  await fs.mkdir(buildDir);
  await fs.mkdir(lockRoot);
  await fs.writeFile(path.join(input, 'app.ts'), 'source');
  await fs.writeFile(path.join(buildDir, 'app.js'), 'compiled');
  return {
    cacheOptions: {
      buildDir,
      environment: { NODE_ENV: 'production' },
      inputs: [input],
      markerPath,
      sourcePath: input,
    },
    input,
    lockOptions: {
      lockPath,
      retries: 50,
      retryDelay: 10,
    },
  };
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await fs.stat(filePath).catch(() => null)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function spawnTransaction(fixture, id) {
  const holderPath = path.join(import.meta.dir, 'fixtures', 'web-build-transaction-holder.js');
  return Bun.spawn([
    process.execPath,
    holderPath,
    path.dirname(fixture.input),
    id,
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('web build coordinator', () => {
  it('rejects Vite CLI arguments before running a production build', () => {
    expect(() => assertWebBuildArguments([])).not.toThrow();
    expect(() => assertWebBuildArguments(['--mode', 'staging'])).toThrow(
      'do not accept Vite CLI arguments: --mode staging',
    );
  });

  it('serializes overlapping builds and reuses the first completed build', async () => {
    const fixture = await createFixture();
    const started = deferred();
    const finish = deferred();
    let compileCalls = 0;
    const compile = async () => {
      compileCalls += 1;
      started.resolve();
      await finish.promise;
      return 0;
    };

    const first = ensureWebBuild({ ...fixture, compile });
    await started.promise;
    const second = ensureWebBuild({ ...fixture, compile });
    finish.resolve();

    expect(await Promise.all([first, second])).toEqual(['built', 'current']);
    expect(compileCalls).toBe(1);
    expect(await isWebBuildCurrent(fixture.cacheOptions)).toBe(true);
  });

  it('waits for the lock before reusing a current mutable-source build', async () => {
    const fixture = await createFixture();
    await recordWebBuild(fixture.cacheOptions);
    const release = await acquireWebBuildLock(fixture.lockOptions);
    const waiting = deferred();

    const result = ensureWebBuild({
      cacheOptions: fixture.cacheOptions,
      lockOptions: {
        ...fixture.lockOptions,
        onContention: waiting.resolve,
      },
    });
    expect(await Promise.race([
      waiting.promise.then(() => 'waiting'),
      result.then(() => 'returned'),
    ])).toBe('waiting');

    await release();
    expect(await result).toBe('current');
  });

  it('removes the marker when compilation fails', async () => {
    const fixture = await createFixture();
    await recordWebBuild(fixture.cacheOptions);
    await fs.writeFile(path.join(fixture.input, 'app.ts'), 'changed');

    await expect(ensureWebBuild({
      ...fixture,
      compile: async () => 7,
    })).rejects.toMatchObject({
      exitCode: 7,
      name: WebBuildProcessError.name,
    });
    await expect(fs.stat(fixture.cacheOptions.markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves the marker absent when sources change during compilation', async () => {
    const fixture = await createFixture();
    await recordWebBuild(fixture.cacheOptions);
    await fs.writeFile(path.join(fixture.input, 'app.ts'), 'changed before build');

    await expect(ensureWebBuild({
      ...fixture,
      compile: async () => {
        await fs.writeFile(path.join(fixture.input, 'app.ts'), 'changed during build');
        return 0;
      },
    })).rejects.toThrow('Web build inputs changed while the client was compiling');
    await expect(fs.stat(fixture.cacheOptions.markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('excludes another process until its lock is released', async () => {
    const fixture = await createFixture();
    const holderPath = path.join(import.meta.dir, 'fixtures', 'web-build-lock-holder.js');
    const holder = Bun.spawn([
      process.execPath,
      holderPath,
      fixture.lockOptions.lockPath,
    ], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    try {
      const reader = holder.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain('ready');

      await expect(acquireWebBuildLock({
        ...fixture.lockOptions,
        retries: 0,
      })).rejects.toMatchObject({ code: 'EEXIST' });
    } finally {
      holder.stdin.end();
      await holder.exited;
    }

    const release = await acquireWebBuildLock({
      ...fixture.lockOptions,
      retries: 0,
    });
    await release();
  });

  it('serializes complete transactions across processes and lets the waiter reuse the build', async () => {
    const fixture = await createFixture();
    const root = path.dirname(fixture.input);
    const first = spawnTransaction(fixture, 'first');
    await waitForFile(path.join(root, 'ready.first'));

    const second = spawnTransaction(fixture, 'second');
    await waitForFile(path.join(root, 'waiting.second'));
    await fs.writeFile(path.join(root, 'publish.first'), '');

    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    expect(await fs.readFile(path.join(root, 'done.first'), 'utf8')).toBe('built');
    expect(await fs.readFile(path.join(root, 'done.second'), 'utf8')).toBe('current');
    await expect(fs.stat(path.join(root, 'ready.second'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await isWebBuildCurrent(fixture.cacheOptions)).toBe(true);
  });

  it('keeps a killed writer lock until explicit offline recovery', async () => {
    const fixture = await createFixture();
    const root = path.dirname(fixture.input);
    const first = spawnTransaction(fixture, 'first');
    await waitForFile(path.join(root, 'ready.first'));
    first.kill(9);
    await first.exited;

    await fs.writeFile(path.join(fixture.input, 'app.ts'), 'replacement');
    const second = spawnTransaction(fixture, 'second');
    await waitForFile(path.join(root, 'waiting.second'));
    await expect(fs.stat(path.join(root, 'ready.second'))).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.rm(fixture.lockOptions.lockPath, { recursive: true });
    await waitForFile(path.join(root, 'ready.second'));
    await fs.writeFile(path.join(root, 'publish.second'), '');

    expect(await second.exited).toBe(0);
    expect(await fs.readFile(path.join(fixture.cacheOptions.buildDir, 'app.js'), 'utf8')).toBe(
      'replacement',
    );
    expect(await isWebBuildCurrent(fixture.cacheOptions)).toBe(true);
  });

  it('propagates permanent lock filesystem errors without retrying', async () => {
    const fixture = await createFixture();
    const invalidParent = path.join(path.dirname(fixture.input), 'not-a-directory');
    await fs.writeFile(invalidParent, '');

    await expect(acquireWebBuildLock({
      lockPath: path.join(invalidParent, 'lock'),
    })).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
