import { describe, expect, test } from 'bun:test';
import { runSystemdOwnershipRequest } from '../systemd/ownership.js';
import { identity, launch, managerGroup, snapshot } from './systemd-fixture.js';

function fixture() {
  const calls = [];
  let current = snapshot();
  let referenced = false;
  let empty = false;
  let loaded = true;
  let elapsed = 0;
  /** @satisfies {import('../systemd/contracts.js').SystemdUnitBus} */
  const bus = {
    refUnit(name) { calls.push(['ref', name]); referenced = loaded; return referenced; },
    unrefUnit(name) { calls.push(['unref', name]); referenced = false; loaded = false; },
    stopUnit(name) {
      calls.push(['stop', name]);
      expect(referenced).toBe(true);
      current = { ...current, activeState: 'deactivating', subState: 'stop-sigterm', jobId: 5 };
    },
    snapshot(name) { calls.push(['snapshot', name]); expect(referenced).toBe(true); return current; },
    exists(name) { calls.push(['exists', name]); return loaded; },
    managerControlGroup() { calls.push(['manager']); return managerGroup; },
    close() { calls.push(['close']); referenced = false; },
  };
  /** @satisfies {import('../systemd/cgroup.js').CgroupReader} */
  const groups = {
    observe(controlGroup, manager) {
      calls.push(['observe', controlGroup, manager]);
      return { isEmpty() { calls.push(['empty']); return empty; } };
    },
  };
  /** @satisfies {import('../systemd/ownership.js').SystemdCleanupWait} */
  const wait = { now: () => elapsed, async pause() { elapsed += 25; current = {
    ...current, activeState: 'inactive', subState: 'dead', mainPid: 0, jobId: 0,
  }; empty = true; } };
  return { bus, groups, wait, calls,
    change(fields) { current = { ...current, ...fields }; },
    setLoaded(value) { loaded = value; }, setEmpty(value) { empty = value; },
  };
}

describe('systemd incarnation ownership', () => {
  test('startup pins before inspection, validates twice and never stops', async () => {
    const f = fixture();
    expect(await runSystemdOwnershipRequest({ kind: 'inspect', launch }, f.bus, f.groups, f.wait))
      .toEqual({ kind: 'ready', identity });
    expect(f.calls.map(([method]) => method)).toEqual(['ref', 'snapshot', 'manager', 'observe', 'snapshot', 'unref', 'close']);
  });

  test('stop holds the same ref through terminal, empty-cgroup and job checks, then waits for unload', async () => {
    const f = fixture();
    expect(await runSystemdOwnershipRequest({ kind: 'stop', identity }, f.bus, f.groups, f.wait))
      .toEqual({ kind: 'stopped' });
    expect(f.calls.map(([method]) => method)).toEqual([
      'ref', 'manager', 'observe', 'snapshot', 'stop', 'snapshot', 'snapshot', 'empty', 'unref', 'exists', 'close',
    ]);
  });

  test.each([
    ['id', 'other.service'], ['description', 'unrelated launch'], ['invocationId', 'd'.repeat(32)],
    ['controlGroup', '/wrong/group'], ['mainPid', 5678], ['loadState', 'not-found'],
    ['serviceType', 'forking'], ['killMode', 'process'], ['sendSigkill', false],
    ['timeoutStopUsec', 6_000_000n], ['restart', 'always'], ['restarts', 1], ['transient', false], ['collectMode', 'inactive'],
  ])('mismatching %s never stops or adopts another incarnation', async (field, value) => {
    const f = fixture();
    f.change({ [field]: value });
    await expect(runSystemdOwnershipRequest({ kind: 'stop', identity }, f.bus, f.groups, f.wait))
      .rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
    expect(f.calls.some(([method]) => method === 'stop')).toBe(false);
    expect(f.calls.at(-1)).toEqual(['close']);
  });

  test('startup rejects a changed incarnation during cgroup validation', async () => {
    const f = fixture();
    f.groups.observe = () => { f.change({ invocationId: 'd'.repeat(32) }); return { isEmpty: () => true }; };
    await expect(runSystemdOwnershipRequest({ kind: 'inspect', launch }, f.bus, f.groups, f.wait))
      .rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
  });

  test.each(['refUnit', 'managerControlGroup', 'snapshot', 'stopUnit', 'unrefUnit', 'exists'])(
    'a disconnect or ambiguous %s error closes without reconnect or stop retry', async (method) => {
      const f = fixture();
      const original = f.bus[method];
      f.bus[method] = (...args) => { original(...args); throw new Error('Synthetic bus disconnect'); };
      await expect(runSystemdOwnershipRequest({ kind: 'stop', identity }, f.bus, f.groups, f.wait))
        .rejects.toThrow('Synthetic bus disconnect');
      expect(f.calls.filter(([method]) => method === 'ref')).toHaveLength(1);
      expect(f.calls.filter(([method]) => method === 'stop').length).toBeLessThanOrEqual(1);
      expect(f.calls.at(-1)).toEqual(['close']);
    },
  );

  test('an unloaded unit is clean only when its recorded cgroup is empty and its name remains unloaded', async () => {
    const f = fixture();
    f.setLoaded(false);
    await expect(runSystemdOwnershipRequest({ kind: 'stop', identity }, f.bus, f.groups, f.wait))
      .rejects.toMatchObject({ code: 'NODE_CLEANUP_FAILED' });
    f.setEmpty(true);
    expect(await runSystemdOwnershipRequest({ kind: 'stop', identity }, f.bus, f.groups, f.wait)).toEqual({ kind: 'stopped' });
    expect(f.calls.some(([method]) => method === 'stop')).toBe(false);
  });

  test.each([
    { mainPid: 1234 }, { jobId: 7 }, { subState: 'stop-sigkill' }, { activeState: 'active' },
  ])('neither cgroup emptiness nor a partial terminal snapshot proves completion: %j', async (fields) => {
    const f = fixture();
    f.change({ activeState: 'inactive', subState: 'dead', mainPid: 0, jobId: 0, ...fields });
    f.setEmpty(true);
    f.bus.stopUnit = () => {};
    f.wait.pause = async () => {};
    await expect(runSystemdOwnershipRequest({ kind: 'stop', identity }, f.bus, f.groups, f.wait))
      .rejects.toMatchObject({ code: 'NODE_CLEANUP_TIMEOUT' });
    expect(f.calls.some(([method]) => method === 'unref')).toBe(false);
  });

  test('terminal state without recursively empty cgroup never releases the pin as success', async () => {
    const f = fixture();
    f.change({ activeState: 'failed', subState: 'failed', mainPid: 0 });
    f.wait.pause = async () => {};
    await expect(runSystemdOwnershipRequest({ kind: 'stop', identity }, f.bus, f.groups, f.wait))
      .rejects.toMatchObject({ code: 'NODE_CLEANUP_TIMEOUT' });
    expect(f.calls.some(([method]) => method === 'stop' || method === 'unref')).toBe(false);
  });

  test('a terminal unit may have released its cgroup path; the recorded path still gets checked', async () => {
    const f = fixture();
    f.change({ activeState: 'failed', subState: 'failed', mainPid: 0, controlGroup: '' });
    f.setEmpty(true);
    expect(await runSystemdOwnershipRequest({ kind: 'stop', identity }, f.bus, f.groups, f.wait)).toEqual({ kind: 'stopped' });
    expect(f.calls).toContainEqual(['observe', identity.controlGroup, managerGroup]);
  });

  test('another client holding the unloaded-name barrier times out without stopping again', async () => {
    const f = fixture();
    f.bus.exists = () => true;
    await expect(runSystemdOwnershipRequest({ kind: 'stop', identity }, f.bus, f.groups, f.wait))
      .rejects.toMatchObject({ code: 'NODE_CLEANUP_TIMEOUT' });
    expect(f.calls.filter(([method]) => method === 'stop')).toHaveLength(1);
  });

  test.each([NaN, Infinity, -1, 10_000])('invalid or exhausted cleanup clock fails closed: %s', async (reading) => {
    const f = fixture();
    let reads = 0;
    f.wait.now = () => reads++ === 0 ? 0 : reading;
    await expect(runSystemdOwnershipRequest({ kind: 'stop', identity }, f.bus, f.groups, f.wait))
      .rejects.toMatchObject({ code: 'NODE_CLEANUP_TIMEOUT' });
  });
});

describe('systemd launch-qualified inert retirement', () => {
  test('pins the exact inert launch through stop, cgroup emptiness, and unload', async () => {
    const f = fixture();
    expect(await runSystemdOwnershipRequest({ kind: 'retire-inert', launch }, f.bus, f.groups, f.wait)).toEqual({ kind: 'retired-inert' });
    expect(f.calls.map(([method]) => method)).toEqual([
      'ref', 'snapshot', 'manager', 'observe', 'stop', 'snapshot', 'snapshot', 'empty', 'unref', 'exists', 'close',
    ]);
  });

  test('absent inert launch needs no fabricated running identity or cgroup witness', async () => {
    const f = fixture(); f.setLoaded(false);
    expect(await runSystemdOwnershipRequest({ kind: 'retire-inert', launch }, f.bus, f.groups, f.wait)).toEqual({ kind: 'retired-inert' });
    expect(f.calls.map(([method]) => method)).toEqual(['ref', 'exists', 'close']);
  });

  test('a launch that appears after a failed ref cannot be stopped without another exact pinned attempt', async () => {
    const f = fixture(); f.setLoaded(false); f.bus.exists = () => true;
    await expect(runSystemdOwnershipRequest({ kind: 'retire-inert', launch }, f.bus, f.groups, f.wait))
      .rejects.toMatchObject({ code: 'NODE_CLEANUP_TIMEOUT' });
    expect(f.calls.some(([method]) => method === 'stop')).toBe(false);
    expect(f.calls.at(-1)).toEqual(['close']);
  });

  test.each(['inactive', 'failed'])('terminal %s inert unit with released cgroup retires without configured-work proof', async (activeState) => {
    const f = fixture();
    f.change({ activeState, subState: activeState === 'inactive' ? 'dead' : 'failed', mainPid: 0, jobId: 0, controlGroup: '' });
    expect(await runSystemdOwnershipRequest({ kind: 'retire-inert', launch }, f.bus, f.groups, f.wait)).toEqual({ kind: 'retired-inert' });
    expect(f.calls.some(([method]) => method === 'stop' || method === 'observe')).toBe(false);
  });

  test('an activating inert launch may not have an invocation, PID, or cgroup yet', async () => {
    const f = fixture();
    f.change({ activeState: 'activating', subState: 'start', mainPid: 0, jobId: 1, invocationId: '0'.repeat(32), controlGroup: '' });
    expect(await runSystemdOwnershipRequest({ kind: 'retire-inert', launch }, f.bus, f.groups, f.wait)).toEqual({ kind: 'retired-inert' });
    expect(f.calls.filter(([method]) => method === 'stop')).toHaveLength(1);
  });

  test('a newly visible cgroup is latched and must empty before inert retirement succeeds', async () => {
    const f = fixture();
    f.change({ activeState: 'activating', subState: 'start', mainPid: 0, jobId: 1, invocationId: '0'.repeat(32), controlGroup: '' });
    let polls = 0;
    f.wait.pause = async () => {
      polls += 1;
      f.change({ activeState: 'inactive', subState: 'dead', mainPid: 0, jobId: 0,
        invocationId: identity.invocationId, controlGroup: identity.controlGroup });
      if (polls === 2) f.setEmpty(true);
    };
    expect(await runSystemdOwnershipRequest({ kind: 'retire-inert', launch }, f.bus, f.groups, f.wait)).toEqual({ kind: 'retired-inert' });
    expect(polls).toBe(2);
    expect(f.calls).toContainEqual(['observe', identity.controlGroup, managerGroup]);
  });

  test.each([
    ['id', 'foreign.service'], ['description', 'foreign launch'], ['loadState', 'not-found'],
    ['serviceType', 'forking'], ['killMode', 'process'], ['sendSigkill', false], ['timeoutStopUsec', 6_000_000n],
    ['restart', 'always'], ['restarts', 1], ['transient', false], ['collectMode', 'inactive'],
  ])('a mismatched %s cannot be adopted or stopped by launch identity', async (field, value) => {
    const f = fixture(); f.change({ [field]: value });
    await expect(runSystemdOwnershipRequest({ kind: 'retire-inert', launch }, f.bus, f.groups, f.wait))
      .rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
    expect(f.calls.some(([method]) => method === 'stop')).toBe(false);
    expect(f.calls.at(-1)).toEqual(['close']);
  });

  test.each([
    { invocationId: 'd'.repeat(32) }, { mainPid: 5678 }, { controlGroup: '/foreign/group' },
  ])('an incarnation change during retirement never reports completion: %j', async (fields) => {
    const f = fixture();
    f.wait.pause = async () => f.change(fields);
    await expect(runSystemdOwnershipRequest({ kind: 'retire-inert', launch }, f.bus, f.groups, f.wait))
      .rejects.toMatchObject({ code: 'NODE_CONTAINMENT_MISMATCH' });
    expect(f.calls.filter(([method]) => method === 'stop')).toHaveLength(1);
    expect(f.calls.some(([method]) => method === 'unref')).toBe(false);
  });

  test('a terminal inert unit with a populated cgroup remains fenced', async () => {
    const f = fixture(); f.change({ activeState: 'inactive', subState: 'dead', mainPid: 0 });
    f.wait.pause = async () => {};
    await expect(runSystemdOwnershipRequest({ kind: 'retire-inert', launch }, f.bus, f.groups, f.wait))
      .rejects.toMatchObject({ code: 'NODE_CLEANUP_TIMEOUT' });
    expect(f.calls.some(([method]) => method === 'unref')).toBe(false);
  });
});
