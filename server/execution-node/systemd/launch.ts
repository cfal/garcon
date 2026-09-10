import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { systemdUnitDescription, type SystemdLaunchIdentity } from './contracts.js';

export interface SystemdExecutionLaunch {
  readonly identity: SystemdLaunchIdentity;
  readonly argv: readonly string[];
}

/**
 * Requires exclusive same-UID management of this unit; RefUnit prevents unload, not operator restart or mutation.
 * Applies only to execution-node processes, never ordinary standalone provider launches.
 */
export function systemdExecutionLaunch(nodeId: string, executable: string, args: readonly string[]): SystemdExecutionLaunch {
  if (!isExecutionIdentity(nodeId) || !isAbsolute(executable)
    || [executable, ...args].some((arg) => arg.includes('\0'))) throw new TypeError('Invalid execution-node launch');
  const identity = Object.freeze({
    unitName: `garcon-exec-${createHash('sha256').update(nodeId).digest('hex')}.service`,
    launchId: randomBytes(16).toString('hex'),
  });
  return {
    identity,
    argv: Object.freeze([
      'systemd-run', '--user', `--unit=${identity.unitName}`, '--service-type=exec', '--pipe', '--wait', '--collect',
      '--expand-environment=no',
      `--description=${systemdUnitDescription(identity.launchId)}`,
      '--property=KillMode=control-group', '--property=SendSIGKILL=yes', '--property=TimeoutStopSec=5s',
      '--property=Restart=no', '--', executable, ...args,
    ]),
  };
}
