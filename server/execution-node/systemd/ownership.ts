import type { CgroupReader } from './cgroup.js';
import {
  isInvocationId, parseSystemdHelperRequest, SYSTEMD_STOP_TIMEOUT_USEC, SystemdContainmentError,
  systemdUnitDescription, type SystemdHelperReply, type SystemdHelperRequest,
  type SystemdLaunchIdentity, type SystemdUnitBus, type SystemdUnitIdentity, type SystemdUnitSnapshot,
} from './contracts.js';

export interface SystemdCleanupWait {
  now(): number;
  pause(): Promise<void>;
}

const DEFAULT_WAIT: SystemdCleanupWait = {
  now: () => performance.now(), pause: () => new Promise((resolve) => setTimeout(resolve, 25)),
};
const CLEANUP_BUDGET_MS = 10_000;
const MAX_POLLS = 400;

/** Never reconnects; a lost pin or ambiguous call abandons this connection without another name-based stop. */
export async function runSystemdOwnershipRequest(
  input: SystemdHelperRequest,
  bus: SystemdUnitBus,
  groups: CgroupReader,
  wait: SystemdCleanupWait = DEFAULT_WAIT,
): Promise<SystemdHelperReply> {
  try {
    const request = parseSystemdHelperRequest(input);
    if (!request) throw mismatch();
    const launch = request.kind === 'stop' ? request.identity : request.launch;
    const referenced = bus.refUnit(launch.unitName);
    if (request.kind === 'inspect') {
      if (!referenced) throw new SystemdContainmentError('NODE_CONTAINMENT_UNAVAILABLE');
      const initial = requireSnapshot(bus.snapshot(launch.unitName), launch);
      requireRunning(initial);
      const identity = Object.freeze({ ...launch, invocationId: initial.invocationId,
        controlGroup: initial.controlGroup, mainPid: initial.mainPid });
      groups.observe(identity.controlGroup, bus.managerControlGroup());
      requireRunning(requireIncarnation(bus.snapshot(launch.unitName), identity));
      bus.unrefUnit(launch.unitName);
      return { kind: 'ready', identity };
    }
    if (request.kind === 'retire-inert') {
      await retireInert(launch, referenced, bus, groups, wait);
      return { kind: 'retired-inert' };
    }

    const identity = request.identity;
    const group = groups.observe(identity.controlGroup, bus.managerControlGroup());
    const started = wait.now();
    if (!Number.isFinite(started)) throw timedOut();
    if (referenced) {
      // The ref precedes all inspection; the final read and stop share this exact bus connection.
      const current = requireIncarnation(bus.snapshot(identity.unitName), identity);
      if (!terminal(current)) bus.stopUnit(identity.unitName);
      await until(() => {
        const current = requireIncarnation(bus.snapshot(identity.unitName), identity);
        return terminal(current) && group.isEmpty();
      }, wait, started);
      bus.unrefUnit(identity.unitName);
    } else if (!group.isEmpty()) {
      throw new SystemdContainmentError('NODE_CLEANUP_FAILED');
    }
    await until(() => !bus.exists(identity.unitName), wait, started);
    return { kind: 'stopped' };
  } finally {
    // Nonflushing close also releases an ambiguous or failed RefUnit on its original sender.
    bus.close();
  }
}

/** Never authorizes cleanup of configured work; a delayed inert launch still competes for the same exclusive unit name. */
async function retireInert(
  launch: SystemdLaunchIdentity, referenced: boolean, bus: SystemdUnitBus, groups: CgroupReader, wait: SystemdCleanupWait,
): Promise<void> {
  const started = wait.now();
  if (!Number.isFinite(started)) throw timedOut();
  if (referenced) {
    let invocationId: string | null = null;
    let mainPid: number | null = null;
    let controlGroup: string | null = null;
    let group: ReturnType<CgroupReader['observe']> | null = null;
    const observe = (): SystemdUnitSnapshot => {
      const current = requireFingerprint(bus.snapshot(launch.unitName), launch);
      if (current.invocationId !== '0'.repeat(32)) {
        if (!isInvocationId(current.invocationId) || invocationId !== null && invocationId !== current.invocationId) throw mismatch();
        invocationId = current.invocationId;
      } else if (invocationId !== null) throw mismatch();
      if (current.mainPid) {
        if (mainPid !== null && mainPid !== current.mainPid) throw mismatch();
        mainPid = current.mainPid;
      }
      if (current.controlGroup) {
        if (controlGroup !== null && controlGroup !== current.controlGroup) throw mismatch();
        if (!group) group = groups.observe(current.controlGroup, bus.managerControlGroup());
        controlGroup = current.controlGroup;
      } else if (controlGroup !== null && !terminal(current)) throw mismatch();
      return current;
    };
    if (!terminal(observe())) bus.stopUnit(launch.unitName);
    await until(() => terminal(observe()) && (group?.isEmpty() ?? true), wait, started);
    bus.unrefUnit(launch.unitName);
  }
  await until(() => !bus.exists(launch.unitName), wait, started);
}

async function until(predicate: () => boolean, wait: SystemdCleanupWait, started: number): Promise<void> {
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    const elapsed = wait.now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= CLEANUP_BUDGET_MS) throw timedOut();
    if (predicate()) return;
    await wait.pause();
  }
  throw timedOut();
}

function terminal(snapshot: SystemdUnitSnapshot): boolean {
  return (snapshot.activeState === 'inactive' && snapshot.subState === 'dead'
    || snapshot.activeState === 'failed' && snapshot.subState === 'failed')
    && snapshot.mainPid === 0 && snapshot.jobId === 0;
}

function requireRunning(snapshot: SystemdUnitSnapshot): void {
  if (snapshot.activeState !== 'active' || snapshot.subState !== 'running' || snapshot.mainPid < 1) throw mismatch();
}

function requireSnapshot(snapshot: SystemdUnitSnapshot | null, launch: SystemdLaunchIdentity): SystemdUnitSnapshot {
  const current = requireFingerprint(snapshot, launch);
  if (!isInvocationId(current.invocationId)) throw mismatch();
  return current;
}

function requireFingerprint(snapshot: SystemdUnitSnapshot | null, launch: SystemdLaunchIdentity): SystemdUnitSnapshot {
  if (!snapshot || snapshot.id !== launch.unitName || snapshot.description !== systemdUnitDescription(launch.launchId)
    || snapshot.loadState !== 'loaded' || !snapshot.transient
    || snapshot.collectMode !== 'inactive-or-failed' || snapshot.serviceType !== 'exec'
    || snapshot.killMode !== 'control-group' || !snapshot.sendSigkill
    || snapshot.timeoutStopUsec !== SYSTEMD_STOP_TIMEOUT_USEC || snapshot.restart !== 'no'
    || snapshot.restarts !== 0) throw mismatch();
  return snapshot;
}

function requireIncarnation(snapshot: SystemdUnitSnapshot | null, identity: SystemdUnitIdentity): SystemdUnitSnapshot {
  const current = requireSnapshot(snapshot, identity);
  if (current.invocationId !== identity.invocationId || current.mainPid !== 0 && current.mainPid !== identity.mainPid
    || current.controlGroup !== identity.controlGroup && !(current.controlGroup === '' && terminal(current))) throw mismatch();
  return current;
}

function mismatch(): SystemdContainmentError { return new SystemdContainmentError('NODE_CONTAINMENT_MISMATCH'); }
function timedOut(): SystemdContainmentError { return new SystemdContainmentError('NODE_CLEANUP_TIMEOUT'); }
