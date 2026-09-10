import { describe, expect, test } from 'bun:test';
import { createPiCatalogRpcDiscovery, type PiCatalogProcessFactory } from '../pi-catalog-rpc.js';

function scriptedProcess(onCommand: (command: Record<string, unknown>) => void = () => {}) {
  const exit = Promise.withResolvers<number>();
  const written = Promise.withResolvers<Record<string, unknown>>();
  const output = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const kills: (number | NodeJS.Signals | undefined)[] = [];
  let closed = false;
  let killed = false;
  let flush = () => Promise.resolve(0);
  const proc = {
    exited: exit.promise,
    get killed() { return killed; },
    kill(signal?: number | NodeJS.Signals) {
      kills.push(signal);
      killed = true;
      finish();
    },
    stdin: {
      write(data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer) {
        const command = JSON.parse(String(data)) as Record<string, unknown>;
        written.resolve(command);
        onCommand(command);
        return String(data).length;
      },
      flush: () => flush(),
    },
    stdout: new ReadableStream<Uint8Array>({
      start(controller) { output.resolve(controller); },
      cancel() { closed = true; },
    }),
  } satisfies ReturnType<PiCatalogProcessFactory['start']>;
  function finish(code = 0) {
    exit.resolve(code);
    void output.promise.then((controller) => {
      if (!closed) {
        closed = true;
        controller.close();
      }
    });
  }
  function emit(value: unknown) {
    return emitBytes(`${JSON.stringify(value)}\n`);
  }
  async function emitBytes(value: string) {
    if (!closed) (await output.promise).enqueue(new TextEncoder().encode(value));
  }
  return { proc, kills, written: written.promise, emit, emitBytes, finish, holdFlush(value: Promise<number>) {
    flush = () => value;
  } };
}

function profile(name = 'first') {
  return { binary: '/synthetic/bin/pi', cwd: `/profiles/${name}`, environment: {
    HOME: `/profiles/${name}`, PI_CODING_AGENT_DIR: `/profiles/${name}/.pi/agent`,
    PATH: '/synthetic/bin:/usr/bin:/bin',
    [`${name.toUpperCase()}_SECRET`]: `synthetic-${name}`,
  } };
}

function reply(command: Record<string, unknown>, models: unknown[]) {
  return { type: 'response', id: command.id, command: 'get_available_models', success: true, data: { models } };
}

const available = [{ provider: 'synthetic', id: 'path/model', input: ['text', 'image'] }];
const expected = [{ value: 'synthetic/path/model', label: 'synthetic: model', supportsImages: true }];

describe('scoped Pi RPC catalog', () => {
  test('uses correlated structured discovery, filters malformed records and settles its process', async () => {
    const child = scriptedProcess();
    const launches: Parameters<PiCatalogProcessFactory['start']>[0][] = [];
    const configuration = profile();
    const discover = createPiCatalogRpcDiscovery({ ...configuration, processes: {
      start(request) { launches.push(request); return child.proc; },
    } });
    configuration.environment.HOME = '/changed';
    const pending = discover(new AbortController().signal);
    const command = await child.written;
    expect(command).toEqual({ id: 'garcon-1', type: 'get_available_models' });
    await child.emit({ ...reply(command, []), id: 'wrong-request' });
    await child.emit(reply(command, [null, [], {}, { provider: '', id: 'empty' },
      { provider: 'synthetic', id: '' }, { provider: 'synthetic' }, ...available]));
    expect(await pending).toEqual(expected);
    expect(launches[0]?.command).toEqual(['/synthetic/bin/pi', '--mode', 'rpc', '--no-session', '--no-tools']);
    expect(launches[0]?.cwd).toBe('/profiles/first');
    expect(launches[0]?.environment).toEqual({
      HOME: '/profiles/first', PI_CODING_AGENT_DIR: '/profiles/first/.pi/agent',
      PATH: '/synthetic/bin:/usr/bin:/bin',
      FIRST_SECRET: 'synthetic-first', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    });
    expect(child.kills).toEqual(['SIGTERM']);
  });

  test('interleaves two profiles without sharing launch environments or results', async () => {
    const first = scriptedProcess();
    const second = scriptedProcess();
    const environments: Readonly<Record<string, string | undefined>>[] = [];
    const reads = [first, second].map((child, index) => createPiCatalogRpcDiscovery({
      ...profile(index === 0 ? 'first' : 'second'), processes: {
        start({ environment }) { environments.push(environment); return child.proc; },
      },
    })(new AbortController().signal));
    const [firstCommand, secondCommand] = await Promise.all([first.written, second.written]);
    await second.emit(reply(secondCommand, [{ provider: 'synthetic', id: 'second' }]));
    expect((await reads[1])?.[0]?.value).toBe('synthetic/second');
    await first.emit(reply(firstCommand, [{ provider: 'synthetic', id: 'first' }]));
    expect((await reads[0])?.[0]?.value).toBe('synthetic/first');
    expect(environments[0]).not.toHaveProperty('SECOND_SECRET');
    expect(environments[1]).not.toHaveProperty('FIRST_SECRET');
    expect(environments.map((environment) => environment.HOME)).toEqual(['/profiles/first', '/profiles/second']);
    expect([first.kills, second.kills]).toEqual([['SIGTERM'], ['SIGTERM']]);
  });

  test('rejects cancellation before launch without acquiring a process', async () => {
    let starts = 0;
    const discover = createPiCatalogRpcDiscovery({ ...profile(), processes: {
      start() { starts += 1; throw new Error('Unexpected launch'); },
    } });
    const signal = AbortSignal.abort(new Error('Synthetic cancellation'));
    await expect(discover(signal)).rejects.toBe(signal.reason);
    expect(starts).toBe(0);
  });

  test('cancellation interrupts a held stdin write and awaits process cleanup', async () => {
    const child = scriptedProcess();
    const flushed = Promise.withResolvers<number>();
    child.holdFlush(flushed.promise);
    const controller = new AbortController();
    const discover = createPiCatalogRpcDiscovery({ ...profile(), processes: { start: () => child.proc } });
    const pending = discover(controller.signal);
    await child.written;
    controller.abort(new Error('Synthetic cancellation'));
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(child.kills).toEqual(['SIGTERM']);
    flushed.resolve(0);
  });

  test('bounds startup and a held stdin write before the RPC response timer starts', async () => {
    const child = scriptedProcess();
    const flushed = Promise.withResolvers<number>();
    child.holdFlush(flushed.promise);
    const discover = createPiCatalogRpcDiscovery({ ...profile(), timeoutMs: 10,
      processes: { start: () => child.proc },
    });
    await expect(discover(new AbortController().signal)).rejects.toMatchObject({
      message: 'Pi catalog discovery timed out',
    });
    expect(child.kills).toEqual(['SIGTERM']);
    flushed.resolve(0);
  });

  test.each([
    ['malformed JSON', '{not-json}\n', 'malformed RPC output'],
    ['invalid model list', JSON.stringify({ type: 'response', id: 'garcon-1', command: 'get_available_models',
      success: true, data: { models: null } }) + '\n', 'invalid model list'],
    ['wrong command', JSON.stringify({ type: 'response', id: 'garcon-1', command: 'get_state',
      success: true, data: { models: [] } }) + '\n', 'invalid model list'],
    ['empty catalog', JSON.stringify(reply({ id: 'garcon-1' }, [])) + '\n', 'no available models'],
    ['unmappable catalog', JSON.stringify(reply({ id: 'garcon-1' }, [null, {}, []])) + '\n', 'no available models'],
    ['unbounded output', 'x'.repeat(4 * 1024 * 1024 + 1), 'byte limit'],
  ])('rejects %s and terminates the acquired process', async (_name, output, message) => {
    const child = scriptedProcess();
    const discover = createPiCatalogRpcDiscovery({ ...profile(), processes: { start: () => child.proc } });
    const pending = discover(new AbortController().signal);
    await child.written;
    await child.emitBytes(output);
    await expect(pending).rejects.toThrow(message);
    expect(child.kills).toEqual(['SIGTERM']);
  });

  test('treats an early exit without RPC as unavailable, not a successful empty catalog', async () => {
    const child = scriptedProcess();
    const discover = createPiCatalogRpcDiscovery({ ...profile(), processes: { start: () => child.proc } });
    const pending = discover(new AbortController().signal);
    await child.written;
    child.finish(1);
    await expect(pending).rejects.toThrow('exited with code 1');
    expect(child.kills).toEqual(['SIGTERM']);
  });

  test('bounds cumulative output across chunks before a complete record exists', async () => {
    const child = scriptedProcess();
    const discover = createPiCatalogRpcDiscovery({ ...profile(), processes: { start: () => child.proc } });
    const pending = discover(new AbortController().signal);
    await child.written;
    await child.emitBytes('x'.repeat(2 * 1024 * 1024));
    await child.emitBytes('x'.repeat(2 * 1024 * 1024));
    await child.emitBytes('x');
    await expect(pending).rejects.toThrow('byte limit');
    expect(child.kills).toEqual(['SIGTERM']);
  });

  test('retains both discovery and cleanup failures instead of reporting success', async () => {
    const child = scriptedProcess();
    const cleanupError = new Error('Synthetic cleanup failure');
    const discover = createPiCatalogRpcDiscovery({ ...profile(), processes: {
      start: () => ({ ...child.proc, kill() { child.finish(); throw cleanupError; } }),
    } });
    const pending = discover(new AbortController().signal);
    await child.written;
    await child.emitBytes('{invalid}\n');
    const error = await pending.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'Pi catalog returned malformed RPC output' }), cleanupError,
    ]);
  });

  test('retains cancellation during cleanup together with the cleanup failure after a successful read', async () => {
    const child = scriptedProcess();
    const controller = new AbortController();
    const cancellation = new Error('Synthetic cancellation during cleanup');
    const cleanupError = new Error('Synthetic cleanup failure');
    const discover = createPiCatalogRpcDiscovery({ ...profile(), processes: {
      start: () => ({ ...child.proc, kill() {
        controller.abort(cancellation);
        child.finish();
        throw cleanupError;
      } }),
    } });
    const pending = discover(controller.signal);
    const command = await child.written;
    await child.emit(reply(command, available));
    const error = await pending.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('Expected combined cancellation and cleanup failures');
    expect(error.errors).toEqual([cancellation, cleanupError]);
  });

  test('rejects cancellation during successful cleanup after a successful read', async () => {
    const child = scriptedProcess();
    const controller = new AbortController();
    const cancellation = new Error('Synthetic cancellation during cleanup');
    const discover = createPiCatalogRpcDiscovery({ ...profile(), processes: {
      start: () => ({ ...child.proc, kill() {
        controller.abort(cancellation);
        child.finish();
      } }),
    } });
    const pending = discover(controller.signal);
    const command = await child.written;
    await child.emit(reply(command, available));
    await expect(pending).rejects.toBe(cancellation);
  });

  test('does not publish arbitrary provider command diagnostics as catalog errors', async () => {
    const child = scriptedProcess();
    const discover = createPiCatalogRpcDiscovery({ ...profile(), processes: { start: () => child.proc } });
    const pending = discover(new AbortController().signal);
    const command = await child.written;
    await child.emit({ ...reply(command, []), success: false, error: 'Synthetic credential: do-not-publish' });
    await expect(pending).rejects.toThrow('check the profile model and credential configuration');
  });

  test('requires explicit absolute profile roots instead of ambient defaults', () => {
    for (const options of [
      { ...profile(), binary: 'pi' },
      { ...profile(), cwd: '.' },
      { ...profile(), environment: {} },
      { ...profile(), environment: { HOME: '/profiles/first' } },
    ]) expect(() => createPiCatalogRpcDiscovery(options)).toThrow('requires an absolute');
    expect(() => createPiCatalogRpcDiscovery({ ...profile(), environment: { ...profile().environment, PATH: '' } }))
      .toThrow('explicit executable PATH');
  });
});
