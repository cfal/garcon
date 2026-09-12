import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { systemdUnitDescription, type SystemdLaunchIdentity } from './contracts.js';

export interface SystemdExecutionLaunch {
  readonly identity: SystemdLaunchIdentity;
  readonly argv: readonly string[];
}

export interface SystemdExecutionLaunchOptions {
  readonly workingDirectory?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

/**
 * Requires exclusive same-UID management of this unit; RefUnit prevents unload, not operator restart or mutation.
 * Applies only to execution-node processes, never ordinary standalone provider launches.
 */
export function systemdExecutionLaunch(nodeId: string, executable: string, args: readonly string[], options: SystemdExecutionLaunchOptions = {}): SystemdExecutionLaunch {
  if (!isExecutionIdentity(nodeId) || !isAbsolute(executable)
    || [executable, ...args].some((arg) => arg.includes('\0'))) throw new TypeError('Invalid execution-node launch');
  if (options.workingDirectory !== undefined && (!isAbsolute(options.workingDirectory) || options.workingDirectory.includes('\0'))) {
    throw new TypeError('Invalid execution-node working directory');
  }
  const environment = Object.entries(options.environment ?? {});
  if (environment.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0'))) {
    throw new TypeError('Invalid execution-node environment');
  }
  const identity = Object.freeze({
    unitName: systemdExecutionUnitName(nodeId),
    launchId: randomBytes(16).toString('hex'),
  });
  return Object.freeze({
    identity,
    argv: Object.freeze([
      'systemd-run', '--user', `--unit=${identity.unitName}`, '--service-type=exec', '--pipe', '--wait', '--collect',
      '--expand-environment=no',
      `--description=${systemdUnitDescription(identity.launchId)}`,
      '--property=KillMode=control-group', '--property=SendSIGKILL=yes', '--property=TimeoutStopSec=5s',
      '--property=Restart=no',
      ...(options.workingDirectory === undefined ? [] : [`--working-directory=${options.workingDirectory}`]),
      ...environment.map(([key, value]) => `--setenv=${key}=${value}`), '--', executable, ...args,
    ]),
  });
}

export function systemdExecutionUnitName(nodeId: string): string {
  if (!isExecutionIdentity(nodeId)) throw new TypeError('Invalid execution node identity');
  return `garcon-exec-${createHash('sha256').update(nodeId).digest('hex')}.service`;
}
