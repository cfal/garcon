import { systemdUnitDescription } from '../systemd/contracts.js';

export const launch = Object.freeze({ unitName: `garcon-exec-${'a'.repeat(64)}.service`, launchId: 'b'.repeat(32) });
export const managerGroup = '/user.slice/user-1000.slice/user@1000.service';
export const identity = Object.freeze({ ...launch, invocationId: 'c'.repeat(32),
  controlGroup: `${managerGroup}/app.slice/${launch.unitName}`, mainPid: 1234 });

/** @returns {import('../systemd/contracts.js').SystemdUnitSnapshot} */
export function snapshot() {
  return {
    id: launch.unitName, description: systemdUnitDescription(launch.launchId),
    invocationId: identity.invocationId, controlGroup: identity.controlGroup,
    loadState: 'loaded', activeState: 'active', subState: 'running', mainPid: identity.mainPid, jobId: 0,
    serviceType: 'exec', killMode: 'control-group', sendSigkill: true, timeoutStopUsec: 5_000_000n,
    restart: 'no', restarts: 0, transient: true, collectMode: 'inactive-or-failed',
  };
}
