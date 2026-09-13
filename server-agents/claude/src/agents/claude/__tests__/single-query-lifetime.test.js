import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { ClaudeCliVersionProbe } from '../cli-version.js';
import { createClaudeSingleQueryLifetime } from '../single-query-lifetime.js';

const encoder = new TextEncoder();
const tick = () => new Promise((resolve) => setImmediate(resolve));
const cleanups = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function processFixture() {
  const exited = Promise.withResolvers();
  let stdout;
  let stderr;
  const process = {
    killed: false,
    signalCode: null,
    exited: exited.promise,
    stdout: new ReadableStream({ start(controller) { stdout = controller; } }),
    stderr: new ReadableStream({ start(controller) { stderr = controller; } }),
    kill: mock(() => { process.killed = true; }),
  };
  void exited.promise.then(() => { process.killed = true; }, () => {});
  return { process, exited, stdout, stderr };
}

function fixture({ holdProbe = false } = {}) {
  const probe = processFixture();
  const query = processFixture();
  const caller = new AbortController();
  const values = {
    binary: 'synthetic-claude',
    anthropicApiKey: 'synthetic-key',
    anthropicBaseUrl: 'https://host.invalid',
    configHomeDir: '/synthetic-home',
  };
  const config = Object.fromEntries(Object.keys(values).map((key) => [key, () => values[key]]));
  const spawn = spyOn(Bun, 'spawn').mockImplementation((command) =>
    command[1] === '--version' ? probe.process : query.process);
  cleanups.push(() => spawn.mockRestore());
  if (!holdProbe) {
    probe.stdout.enqueue(encoder.encode('2.1.220'));
    probe.stdout.close();
    probe.stderr.close();
    probe.exited.resolve(0);
  }
  const lifetime = createClaudeSingleQueryLifetime(config, {
    binary: config.binary,
    versionProbe: new ClaudeCliVersionProbe(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const request = {
    prompt: 'synthetic input', projectPath: '/synthetic-project', model: 'synthetic-model',
    thinkingMode: 'none', settings: { ownerId: 'claude', schemaVersion: 1, values: {} },
    endpoint: null, signal: caller.signal,
  };
  return { probe, query, caller, values, spawn, request, begin: () => lifetime.begin(request) };
}

function observe(attempt) {
  let settled = false;
  const result = attempt.result.catch((error) => error);
  const completion = attempt.settled.then(() => { settled = true; }, (error) => error);
  return { result, completion, get settled() { return settled; } };
}

test('returns cleanup authority before native entry and captures the request and host configuration', async () => {
  const f = fixture();
  const attempt = f.begin();
  const observed = observe(attempt);
  expect(attempt).not.toBeInstanceOf(Promise);
  expect(f.spawn).not.toHaveBeenCalled();
  f.request.prompt = 'changed input';
  f.request.projectPath = '/changed-project';
  f.values.binary = 'changed-claude';
  f.values.anthropicApiKey = 'changed-key';
  f.values.configHomeDir = '/changed-home';
  expect(await attempt.dispatch).toEqual({ kind: 'accepted' });
  expect(f.spawn.mock.calls[0][0]).toEqual(['synthetic-claude', '--version']);
  expect(f.spawn.mock.calls[1][0]).toEqual([
    'synthetic-claude', '--print', '--no-session-persistence', '--model', 'synthetic-model', '-p', 'synthetic input',
  ]);
  expect(f.spawn.mock.calls[1][1]).toMatchObject({
    cwd: '/synthetic-project',
    env: { ANTHROPIC_API_KEY: 'synthetic-key', ANTHROPIC_BASE_URL: 'https://host.invalid', CLAUDE_CONFIG_DIR: '/synthetic-home' },
  });
  f.query.stdout.enqueue(encoder.encode('synthetic answer'));
  f.query.stdout.close();
  f.query.stderr.close();
  f.query.exited.resolve(0);
  expect(await observed.result).toBe('synthetic answer');
  await observed.completion;
  expect(observed.settled).toBe(true);
  expect(await attempt.abort()).toBe(false);
});

test.each(['cancelled', 'invalid-endpoint'])('%s refuses before any version probe or native query', async (reason) => {
  const f = fixture();
  if (reason === 'invalid-endpoint') f.request.endpoint = { selection: { protocol: 'openai-compatible' } };
  const attempt = f.begin();
  const observed = observe(attempt);
  if (reason === 'cancelled') expect(await attempt.abort()).toBe(true);
  expect(await attempt.dispatch).toMatchObject({ kind: 'rejected' });
  expect(await observed.result).toMatchObject(reason === 'cancelled' ? { name: 'AbortError' } : { code: 'INVALID_ENDPOINT' });
  await observed.completion;
  expect(observed.settled).toBe(true);
  expect(f.spawn).not.toHaveBeenCalled();
});

describe('Claude query native settlement', () => {
  for (const held of ['stdout', 'stderr', 'exit']) {
    test(`retains the query through held ${held}`, async () => {
      const f = fixture();
      const attempt = f.begin();
      const observed = observe(attempt);
      await attempt.dispatch;
      f.query.stdout.enqueue(encoder.encode('synthetic answer'));
      if (held !== 'stdout') f.query.stdout.close();
      if (held !== 'stderr') f.query.stderr.close();
      if (held !== 'exit') f.query.exited.resolve(0);
      await tick();
      expect(observed.settled).toBe(false);
      if (held === 'exit') f.query.exited.resolve(0);
      else f.query[held].close();
      expect(await observed.result).toBe('synthetic answer');
      await observed.completion;
      expect(observed.settled).toBe(true);
      expect(f.query.process.stdout.locked).toBe(false);
      expect(f.query.process.stderr.locked).toBe(false);
    });

    test(`cancelled work retains a held version-probe ${held}`, async () => {
      const f = fixture({ holdProbe: true });
      const attempt = f.begin();
      const observed = observe(attempt);
      await tick();
      const reason = new Error('Synthetic caller cancellation');
      f.caller.abort(reason);
      expect(await observed.result).toBe(reason);
      expect(await attempt.dispatch).toMatchObject({ kind: 'unknown' });
      f.probe.stdout.enqueue(encoder.encode('2.1.220'));
      if (held !== 'stdout') f.probe.stdout.close();
      if (held !== 'stderr') f.probe.stderr.close();
      if (held !== 'exit') f.probe.exited.resolve(0);
      await tick();
      expect(observed.settled).toBe(false);
      if (held === 'exit') f.probe.exited.resolve(0);
      else f.probe[held].close();
      await observed.completion;
      expect(observed.settled).toBe(true);
      expect(f.spawn).toHaveBeenCalledTimes(1);
    });
  }

  test.each(['cancel', 'timeout'])('%s rejects the caller while an abort-ignoring query remains owned', async (action) => {
    const f = fixture();
    if (action === 'timeout') f.request.timeoutMs = 5;
    const attempt = f.begin();
    const observed = observe(attempt);
    await attempt.dispatch;
    if (action === 'cancel') expect(await attempt.abort()).toBe(true);
    expect(await observed.result).toMatchObject(action === 'cancel' ? { name: 'AbortError' } : { code: 'TIMEOUT' });
    expect(f.spawn.mock.calls[1][1].signal.aborted).toBe(true);
    expect(observed.settled).toBe(false);
    f.query.stdout.close();
    f.query.stderr.close();
    f.query.exited.resolve(0);
    expect(await observed.completion).toBeInstanceOf(Error);
    expect(observed.settled).toBe(false);
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });

  test.each(['exit', 'stdout', 'stderr', 'signal', 'nonzero'])('%s failure never attests settlement', async (failure) => {
    const f = fixture();
    const attempt = f.begin();
    const observed = observe(attempt);
    await attempt.dispatch;
    const error = new Error(`Synthetic ${failure} failure`);
    if (failure === 'signal') f.query.process.signalCode = 'SIGTERM';
    if (failure === 'exit') f.query.exited.reject(error);
    else f.query.exited.resolve(failure === 'nonzero' ? 1 : 0);
    if (failure === 'stdout') f.query.stdout.error(error);
    else f.query.stdout.close();
    await tick();
    expect(observed.settled).toBe(false);
    if (failure === 'stderr') f.query.stderr.error(error);
    else f.query.stderr.close();
    await observed.result;
    expect(await observed.completion).toBeInstanceOf(Error);
    expect(observed.settled).toBe(false);
  });

  test('a spawn exception after probe entry remains unknown and cannot discard cleanup uncertainty', async () => {
    const f = fixture();
    f.spawn.mockImplementation((command) => {
      if (command[1] === '--version') return f.probe.process;
      throw new Error('Synthetic spawn failure');
    });
    const attempt = f.begin();
    const observed = observe(attempt);
    expect(await attempt.dispatch).toMatchObject({ kind: 'unknown' });
    expect(await observed.result).toMatchObject({ code: 'PROVIDER_FAILURE' });
    expect(await observed.completion).toMatchObject({ message: 'Synthetic spawn failure' });
    expect(observed.settled).toBe(false);
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });
});
