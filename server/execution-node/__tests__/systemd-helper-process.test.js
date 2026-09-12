import { describe, expect, test } from 'bun:test';
import { runSystemdHelper } from '../systemd/helper-process.js';
import { SYSTEMD_HELPER_MAX_BYTES, SYSTEMD_HELPER_TIMEOUT_MS } from '../systemd/contracts.js';
import { identity, launch } from './systemd-fixture.js';

function fixture(request = { kind: 'inspect', launch }) {
  let output;
  let expire;
  let killed = 0;
  let cancelled = 0;
  const exit = Promise.withResolvers();
  const stream = new ReadableStream({ start(controller) { output = controller; } });
  /** @satisfies {import('../systemd/helper-process.js').SystemdHelperOptions} */
  const options = {
    spawn: (text) => {
      expect(JSON.parse(text)).toEqual(request);
      return { output: stream, exited: exit.promise, kill() { killed += 1; } };
    },
    scheduleTimeout(callback, delay) {
      expect(delay).toBe(SYSTEMD_HELPER_TIMEOUT_MS);
      expire = callback;
      return { cancel() { cancelled += 1; } };
    },
  };
  return { options,
    send(content) { output.enqueue(new TextEncoder().encode(content)); },
    close() { output.close(); }, exit: (code = 0) => exit.resolve(code), rejectExit: (error) => exit.reject(error), expire: () => expire(),
    killed: () => killed, cancelled: () => cancelled,
  };
}

describe('systemd helper process boundary', () => {
  test.each(['EAGAIN', 'EMFILE', 'ENOENT'])('sanitizes helper spawn failure %s without starting a cleanup timer', async (code) => {
    let scheduled = false;
    const result = runSystemdHelper({ kind: 'inspect', launch }, {
      spawn() { throw Object.assign(new Error('synthetic private executable path'), { code }); },
      scheduleTimeout() { scheduled = true; return { cancel() {} }; },
    });
    await expect(result).rejects.toMatchObject({ code: 'NODE_CONTAINMENT_UNAVAILABLE' });
    await expect(result).rejects.not.toThrow('synthetic private executable path');
    expect(scheduled).toBe(false);
  });

  test('readiness is not accepted until the helper exits and releases native resources', async () => {
    const f = fixture();
    let finished = false;
    const result = runSystemdHelper({ kind: 'inspect', launch }, f.options).then((reply) => { finished = true; return reply; });
    f.send(JSON.stringify({ kind: 'ready', identity }));
    f.close();
    await new Promise(setImmediate);
    expect(finished).toBe(false);
    f.exit();
    expect(await result).toEqual({ kind: 'ready', identity });
    expect(f.killed()).toBe(0);
    expect(f.cancelled()).toBe(1);
  });

  test('hard deadline kills only its helper and waits for actual reaping before failing', async () => {
    const f = fixture();
    let failure;
    const result = runSystemdHelper({ kind: 'inspect', launch }, f.options).catch((error) => { failure = error; });
    f.expire();
    await new Promise(setImmediate);
    expect(f.killed()).toBe(1);
    expect(failure).toBeUndefined();
    f.close();
    f.exit(137);
    await result;
    expect(failure).toMatchObject({ code: 'NODE_CLEANUP_TIMEOUT' });
    expect(f.cancelled()).toBe(1);
  });

  test('oversized helper output is killed and reaped without accepting a prefix', async () => {
    const f = fixture();
    const result = runSystemdHelper({ kind: 'inspect', launch }, f.options).catch((error) => error);
    f.send('x'.repeat(SYSTEMD_HELPER_MAX_BYTES + 1));
    await new Promise(setImmediate);
    expect(f.killed()).toBe(1);
    f.close();
    f.exit(137);
    expect(await result).toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
  });

  test.each([false, true])('rejected exit observation retains the cleanup fence when kill throws: %s', async (killThrows) => {
    const f = fixture();
    const spawn = f.options.spawn;
    f.options.spawn = (request) => {
      const child = spawn(request);
      return { ...child, kill() { child.kill(); if (killThrows) throw new Error('synthetic private kill error'); } };
    };
    let settled = false;
    void runSystemdHelper({ kind: 'inspect', launch }, f.options).then(() => { settled = true; }, () => { settled = true; });
    f.send(JSON.stringify({ kind: 'ready', identity })); f.close();
    f.rejectExit(new Error('synthetic private exit error'));
    await new Promise(setImmediate);
    expect(f.killed()).toBe(1);
    expect(settled).toBe(false);
    f.expire();
    await new Promise(setImmediate);
    expect(settled).toBe(false);
    expect(f.cancelled()).toBe(0);
  });

  test('a throwing kill cannot escape the typed timeout after subsequent confirmed exit', async () => {
    const f = fixture();
    const spawn = f.options.spawn;
    f.options.spawn = (request) => ({ ...spawn(request), kill() { throw new Error('synthetic private kill error'); } });
    let settled = false;
    const result = runSystemdHelper({ kind: 'inspect', launch }, f.options).catch((error) => { settled = true; return error; });
    f.expire();
    await new Promise(setImmediate);
    expect(settled).toBe(false);
    f.close(); f.exit(137);
    expect(await result).toMatchObject({ code: 'NODE_CLEANUP_TIMEOUT' });
    expect(f.cancelled()).toBe(1);
  });

  test.each([
    { kind: 'ready', identity: { ...identity, launchId: 'd'.repeat(32) } },
    { kind: 'ready', identity: { ...identity, unitName: `garcon-exec-${'d'.repeat(64)}.service` } },
    { kind: 'stopped' }, { kind: 'retired-inert' }, { kind: 'failed', code: 'invented' }, { kind: 'ready', identity, extra: true },
  ])('rejects a mismatching or malformed reply: %j', async (reply) => {
    const f = fixture();
    const result = runSystemdHelper({ kind: 'inspect', launch }, f.options);
    f.send(JSON.stringify(reply)); f.close(); f.exit();
    await expect(result).rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
  });

  test('helper native failure is sanitized and cannot report success via a valid-looking body', async () => {
    const f = fixture();
    const result = runSystemdHelper({ kind: 'inspect', launch }, f.options);
    f.send(JSON.stringify({ kind: 'ready', identity })); f.close(); f.exit(139);
    await expect(result).rejects.toMatchObject({ code: 'NODE_CLEANUP_FAILED' });
  });

  test('an invalid request never starts a helper', async () => {
    await expect(runSystemdHelper({ kind: 'stop', identity: { ...identity, mainPid: 0 } }, {
      spawn() { throw new Error('must not spawn'); },
    })).rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
  });

  test.each([
    [{ kind: 'stop', identity }, { kind: 'retired-inert' }],
    [{ kind: 'retire-inert', launch }, { kind: 'stopped' }],
  ])('inert retirement and configured-work cleanup cannot substitute for each other', async (request, reply) => {
    const f = fixture(request);
    const result = runSystemdHelper(request, f.options);
    f.send(JSON.stringify(reply)); f.close(); f.exit();
    await expect(result).rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
  });
});
