import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNativeDirectoryPicker, type NativeDirectoryPickerDependencies } from '../native-directory-picker.js';
import { FilesService } from '../service.js';
import { toExecutorPath } from '../../../common/executor-path.js';

type Command = Parameters<NativeDirectoryPickerDependencies['spawn']>[0];

function stream(content: string) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(content)); controller.close(); } });
}

function finished(stdout: string, code = 0, stderr = '') {
  return { stdout: stream(stdout), stderr: stream(stderr), exited: Promise.resolve(code), kill() {} };
}

function fixture(platform: NodeJS.Platform = 'win32') {
  const commands: Command[] = [];
  const results: ReturnType<typeof finished>[] = [];
  const dependencies: NativeDirectoryPickerDependencies = {
    platform, environment: platform === 'linux' ? { DISPLAY: ':1' } : {},
    which: (command) => `/synthetic/${command}`,
    spawn(command) {
      commands.push(command);
      const result = results.shift();
      if (!result) throw new Error('Unexpected helper launch');
      return result;
    },
  };
  return { commands, results, dependencies, picker: () => createNativeDirectoryPicker(dependencies) };
}

function pendingHelper() {
  const exit = Promise.withResolvers<number>();
  let kills = 0;
  return {
    stdout: stream('{"status":"cancelled"}'), stderr: stream(''), exited: exit.promise,
    kill() { kills++; },
    settle() { exit.resolve(0); },
    get kills() { return kills; },
  };
}

describe('native directory picker (injected helpers only)', () => {
  it('keeps Windows paths as JSON data outside its static STA script', async () => {
    const test = fixture();
    const initial = 'C:\\synthetic\\$(hello) ` " café ';
    test.results.push(finished(JSON.stringify({ status: 'selected', path: initial })));
    expect(await test.picker()(initial)).toEqual({ status: 'selected', path: initial });
    const command = test.commands[0]!;
    expect(command.argv).toContain('-STA');
    expect(command.argv).toContain('-NonInteractive');
    expect(JSON.parse(command.input!)).toEqual({ directoryPath: initial });
    const script = Buffer.from(command.argv.at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain('FolderBrowserDialog');
    expect(script).toContain('[Console]::In.ReadToEnd()');
    expect(script).not.toContain(initial);
  });

  it('preserves cancellation and unsupported helper results', async () => {
    const test = fixture();
    for (const status of ['cancelled', 'unsupported'] as const) {
      test.results.push(finished(JSON.stringify({ status })));
      expect(await test.picker()('/synthetic')).toEqual({ status });
    }
    expect(test.commands).toHaveLength(2);
  });

  it('rejects malformed and failed Windows output without exposing paths', async () => {
    const test = fixture();
    for (const result of [finished('{"status":"selected","path":""}'), finished('private path', 2)]) {
      test.results.push(result);
      await expect(test.picker()('/synthetic')).rejects.toThrow('Native folder picker');
    }
  });

  it('does not launch for headless, missing helpers, or unsupported hosts', async () => {
    for (const platform of ['win32', 'darwin', 'linux', 'freebsd'] as const) {
      const test = fixture(platform);
      expect(await createNativeDirectoryPicker({ ...test.dependencies, which: () => null })('/synthetic')).toEqual({ status: 'unsupported' });
      expect(await createNativeDirectoryPicker({ ...test.dependencies, environment: { SSH_CONNECTION: 'synthetic' } })('/synthetic')).toEqual({ status: 'unsupported' });
      expect(test.commands).toHaveLength(0);
    }
    const test = fixture('linux');
    expect(await createNativeDirectoryPicker({ ...test.dependencies, environment: {} })('/synthetic')).toEqual({ status: 'unsupported' });
  });

  it('requires an Aqua session on macOS and passes its path as an argument', async () => {
    const test = fixture('darwin');
    test.results.push(finished('Background\n'));
    expect(await test.picker()('/synthetic')).toEqual({ status: 'unsupported' });
    expect(test.commands).toHaveLength(1);
    const initial = '/synthetic/" $(hello) ';
    test.results.push(finished('Aqua\n'), finished(`${initial}\n`));
    expect(await test.picker()(initial)).toEqual({ status: 'selected', path: initial });
    expect(test.commands[2]!.argv.at(-1)).toBe(initial);
    test.results.push(finished('Aqua\n'), finished('\n'));
    expect(await test.picker()(initial)).toEqual({ status: 'cancelled' });
  });

  it('uses Linux desktop helpers without a shell and keeps cancellation final', async () => {
    const test = fixture('linux');
    const initial = '/synthetic/$(hello) ';
    test.results.push(finished(`${initial}\n`));
    expect(await test.picker()(initial)).toEqual({ status: 'selected', path: initial });
    expect(test.commands[0]!.argv.at(-1)).toBe(`--filename=${initial}/`);
    test.results.push(finished('', 1));
    expect(await test.picker()(initial)).toEqual({ status: 'cancelled' });
    expect(test.commands).toHaveLength(2);
    test.results.push(finished('', 1, 'cannot open display: synthetic'));
    expect(await test.picker()(initial)).toEqual({ status: 'unsupported' });
    test.results.push(finished('/synthetic\n'));
    const kdialog = createNativeDirectoryPicker({ ...test.dependencies, which: (name) => name === 'kdialog' ? '/synthetic/kdialog' : null });
    expect(await kdialog(initial)).toEqual({ status: 'selected', path: '/synthetic' });
    expect(test.commands.at(-1)!.argv).toContain('--getexistingdirectory');
  });

  it('does not dispatch an already aborted request', async () => {
    const test = fixture();
    await expect(test.picker()('/synthetic', { signal: AbortSignal.abort(new Error('synthetic abort')) })).rejects.toThrow('synthetic abort');
    expect(test.commands).toHaveLength(0);
  });

  it('holds process-wide admission after abort until its own helper exits', async () => {
    const test = fixture();
    const helper = pendingHelper();
    const picker = createNativeDirectoryPicker({ ...test.dependencies, spawn: () => helper });
    const abort = new AbortController();
    const selecting = picker('/synthetic', { signal: abort.signal });
    const rejected = selecting.catch((error: unknown) => error);
    abort.abort(new Error('synthetic abort'));
    expect(helper.kills).toBe(1);
    await expect(test.picker()('/synthetic')).rejects.toMatchObject({ code: 'FILE_SERVICE_BUSY' });
    helper.settle();
    expect(await rejected).toMatchObject({ message: 'synthetic abort' });
    test.results.push(finished('{"status":"cancelled"}'));
    expect(await test.picker()('/synthetic')).toEqual({ status: 'cancelled' });
  });

  it('times out and releases admission only after its owned helper settles', async () => {
    const test = fixture();
    const helper = pendingHelper();
    const killed = Promise.withResolvers<void>();
    const picker = createNativeDirectoryPicker({ ...test.dependencies, spawn: () => ({ ...helper, kill() { helper.kill(); killed.resolve(); } }) });
    const selecting = picker('/synthetic', { timeoutMs: 1 });
    const rejected = selecting.catch((error: unknown) => error);
    await killed.promise;
    expect(helper.kills).toBe(1);
    await expect(test.picker()('/synthetic')).rejects.toMatchObject({ code: 'FILE_SERVICE_BUSY' });
    helper.settle();
    expect(await rejected).toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });

  it('bounds each output stream and kills only the oversized helper', async () => {
    for (const field of ['stdout', 'stderr'] as const) {
      let kills = 0;
      const test = fixture();
      const helper = { ...finished('{"status":"cancelled"}'), [field]: stream('x'.repeat(8192)), kill() { kills++; } };
      await expect(createNativeDirectoryPicker({ ...test.dependencies, spawn: () => helper })('/synthetic')).rejects.toThrow('output exceeded');
      expect(kills).toBe(1);
    }
  });
});

describe('FilesService native directory selection', () => {
  const directories: string[] = [];
  afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
  async function root() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-native-picker-'));
    directories.push(directory);
    return fs.realpath(directory);
  }

  it('validates and normalizes initial and selected directories with captured options', async () => {
    const directory = await root();
    const selected = path.join(directory, 'child');
    await fs.mkdir(selected);
    const options = { signal: new AbortController().signal, timeoutMs: 1000 };
    const service = new FilesService({ executorId: 'synthetic', projectBasePath: directory, nativeDirectoryPicker: async (initial, received) => {
      expect(initial).toBe(directory);
      expect(received).toBe(options);
      return { status: 'selected', path: selected };
    } });
    expect(await service.chooseDirectory({}, options)).toEqual({ status: 'selected', path: toExecutorPath(selected) });
  });

  it('rejects invalid initial input before launching a helper', async () => {
    const directory = await root();
    let calls = 0;
    const service = new FilesService({ executorId: 'synthetic', projectBasePath: directory, nativeDirectoryPicker: async () => { calls++; return { status: 'cancelled' }; } });
    await expect(service.chooseDirectory({ directoryPath: '' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(calls).toBe(0);
  });

  it('opens from its validated base when the initial directory was deleted or replaced by a file', async () => {
    const directory = await root();
    const deleted = path.join(directory, 'deleted');
    const file = path.join(directory, 'file');
    await fs.mkdir(deleted);
    await fs.rmdir(deleted);
    await fs.writeFile(file, 'synthetic');
    const initialPaths: string[] = [];
    const service = new FilesService({ executorId: 'synthetic', projectBasePath: directory, nativeDirectoryPicker: async (initial) => {
      initialPaths.push(initial);
      return { status: 'cancelled' };
    } });
    for (const hint of [deleted, file, path.join(file, 'child')]) {
      expect(await service.chooseDirectory({ directoryPath: hint })).toEqual({ status: 'cancelled' });
    }
    expect(initialPaths).toEqual([directory, directory, directory]);
  });

  it('does not replace an out-of-root or permission-denied initial directory', async () => {
    const directory = await root();
    const outside = await root();
    const denied = path.join(directory, 'denied');
    await fs.mkdir(denied);
    let calls = 0;
    const service = new FilesService({ executorId: 'synthetic', projectBasePath: directory, nativeDirectoryPicker: async () => { calls++; return { status: 'cancelled' }; } });
    await expect(service.chooseDirectory({ directoryPath: outside })).rejects.toMatchObject({ code: 'FILE_OUTSIDE_ROOT' });
    const original = fs.stat;
    const intercepted = spyOn(fs, 'stat').mockImplementation(async (...args) => {
      if (args[0] === denied) throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' });
      return original(...args);
    });
    try {
      await expect(service.chooseDirectory({ directoryPath: denied })).rejects.toMatchObject({ code: 'FILE_PERMISSION_DENIED' });
    } finally { intercepted.mockRestore(); }
    expect(calls).toBe(0);
  });

  it('validates the fallback base and retains cancellation and availability failures', async () => {
    const directory = await root();
    const missing = path.join(directory, 'missing');
    let calls = 0;
    const picker = async () => { calls++; return { status: 'cancelled' as const }; };
    const invalidBase = new FilesService({ executorId: 'synthetic', projectBasePath: missing, nativeDirectoryPicker: picker });
    await expect(invalidBase.chooseDirectory({ directoryPath: path.join(missing, 'child') })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    const abort = new AbortController();
    const cancelled = new FilesService({ executorId: 'synthetic', projectBasePath: directory, nativeDirectoryPicker: picker });
    await expect(cancelled.chooseDirectory({ directoryPath: missing }, { signal: AbortSignal.abort(new Error('synthetic cancelled')) })).rejects.toThrow('synthetic cancelled');
    const original = fs.stat;
    const intercepted = spyOn(fs, 'stat').mockImplementation(async (...args) => {
      if (args[0] === missing) abort.abort(new Error('synthetic cancelled'));
      return original(...args);
    });
    try {
      await expect(cancelled.chooseDirectory({ directoryPath: missing }, { signal: abort.signal })).rejects.toThrow('synthetic cancelled');
      const unavailable = new FilesService({ executorId: 'synthetic', projectBasePath: directory, nativeDirectoryPicker: picker,
        assertAvailable() { if (abort.signal.aborted) throw new Error('synthetic unavailable'); },
      });
      await expect(unavailable.chooseDirectory({ directoryPath: missing })).rejects.toThrow('synthetic unavailable');
    } finally { intercepted.mockRestore(); }
    expect(calls).toBe(0);
  });

  it('rejects selected paths outside its root, files, and missing directories', async () => {
    const directory = await root();
    const outside = await root();
    await fs.writeFile(path.join(directory, 'file'), 'synthetic');
    for (const [selected, code] of [[outside, 'FILE_OUTSIDE_ROOT'], [path.join(directory, 'file'), 'FILE_DIRECTORY_REQUIRED'], [path.join(directory, 'missing'), 'FILE_NOT_FOUND']] as const) {
      const service = new FilesService({ executorId: 'synthetic', projectBasePath: directory, nativeDirectoryPicker: async () => ({ status: 'selected', path: selected }) });
      await expect(service.chooseDirectory({})).rejects.toMatchObject({ code });
    }
  });

  it('returns cancel and unsupported unchanged and fences publication after cancellation', async () => {
    const directory = await root();
    for (const status of ['cancelled', 'unsupported'] as const) {
      const service = new FilesService({ executorId: 'synthetic', projectBasePath: directory, nativeDirectoryPicker: async () => ({ status }) });
      expect(await service.chooseDirectory({})).toEqual({ status });
    }
    const abort = new AbortController();
    const service = new FilesService({ executorId: 'synthetic', projectBasePath: directory, nativeDirectoryPicker: async () => {
      abort.abort(new Error('synthetic cancelled'));
      return { status: 'selected', path: directory };
    } });
    await expect(service.chooseDirectory({}, { signal: abort.signal })).rejects.toThrow('synthetic cancelled');
  });

  it('rechecks executor availability after its dialog returns', async () => {
    const directory = await root();
    let available = true;
    const service = new FilesService({ executorId: 'synthetic', projectBasePath: directory,
      assertAvailable() { if (!available) throw new Error('synthetic disposed'); },
      nativeDirectoryPicker: async () => { available = false; return { status: 'selected', path: directory }; },
    });
    await expect(service.chooseDirectory({})).rejects.toThrow('synthetic disposed');
  });
});
