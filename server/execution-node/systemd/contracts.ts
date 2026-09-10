import { isRecord } from '../../../common/json.js';
import { isAbsolute, normalize } from 'node:path/posix';

export const SYSTEMD_STOP_TIMEOUT_USEC = 5_000_000n;
export const SYSTEMD_HELPER_TIMEOUT_MS = 15_000;
export const SYSTEMD_HELPER_MAX_BYTES = 16_384;
export const SYSTEMD_HELPER_FLAG = '--internal-systemd-helper';

export interface SystemdLaunchIdentity {
  readonly unitName: string;
  readonly launchId: string;
}

export interface SystemdUnitIdentity extends SystemdLaunchIdentity {
  readonly invocationId: string;
  readonly controlGroup: string;
  readonly mainPid: number;
}

export interface SystemdUnitSnapshot {
  readonly id: string;
  readonly description: string;
  readonly invocationId: string;
  readonly controlGroup: string;
  readonly loadState: string;
  readonly activeState: string;
  readonly subState: string;
  readonly mainPid: number;
  readonly jobId: number;
  readonly serviceType: string;
  readonly killMode: string;
  readonly sendSigkill: boolean;
  readonly timeoutStopUsec: bigint;
  readonly restart: string;
  readonly restarts: number;
  readonly transient: boolean;
  readonly collectMode: string;
}

export interface SystemdUnitBus {
  refUnit(name: string): boolean;
  unrefUnit(name: string): void;
  stopUnit(name: string): void;
  snapshot(name: string): SystemdUnitSnapshot | null;
  exists(name: string): boolean;
  managerControlGroup(): string;
  close(): void;
}

export type SystemdHelperRequest =
  | { readonly kind: 'inspect'; readonly launch: SystemdLaunchIdentity }
  | { readonly kind: 'stop'; readonly identity: SystemdUnitIdentity };

export type SystemdHelperReply =
  | { readonly kind: 'ready'; readonly identity: SystemdUnitIdentity }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'failed'; readonly code: SystemdContainmentErrorCode };

const FAILURE_CODES = ['NODE_CONTAINMENT_UNAVAILABLE', 'NODE_CONTAINMENT_MISMATCH', 'NODE_CLEANUP_FAILED', 'NODE_CLEANUP_TIMEOUT'] as const;
export type SystemdContainmentErrorCode = typeof FAILURE_CODES[number];

export class SystemdContainmentError extends Error {
  constructor(readonly code: SystemdContainmentErrorCode) {
    super(code);
    this.name = 'SystemdContainmentError';
  }
}

export function systemdUnitDescription(launchId: string): string {
  return `Garcon execution node ${launchId}`;
}

export function isInvocationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) && value !== '0'.repeat(32);
}

export function isControlGroup(value: unknown): value is string {
  return typeof value === 'string' && value.length > 1 && value.length <= 4_096
    && !value.includes('\0') && isAbsolute(value) && normalize(value) === value
    && !value.split('/').includes('..') && !value.endsWith('/');
}

function isLaunch(value: unknown): value is SystemdLaunchIdentity {
  return isRecord(value) && typeof value.unitName === 'string'
    && /^garcon-exec-[0-9a-f]{64}\.service$/.test(value.unitName) && isInvocationId(value.launchId);
}

export function parseSystemdIdentity(value: unknown): SystemdUnitIdentity | null {
  if (!isRecord(value) || Object.keys(value).length !== 5 || !isLaunch(value)
    || !isInvocationId(value.invocationId) || !isControlGroup(value.controlGroup)
    || !Number.isSafeInteger(value.mainPid) || typeof value.mainPid !== 'number'
    || value.mainPid < 1 || value.mainPid > 0xffff_ffff) return null;
  return { unitName: value.unitName, launchId: value.launchId,
    invocationId: value.invocationId, controlGroup: value.controlGroup, mainPid: value.mainPid };
}

export function parseSystemdHelperRequest(value: unknown): SystemdHelperRequest | null {
  if (!isRecord(value) || Object.keys(value).length !== 2) return null;
  if (value.kind === 'inspect' && isLaunch(value.launch) && Object.keys(value.launch).length === 2) {
    return { kind: 'inspect', launch: { unitName: value.launch.unitName, launchId: value.launch.launchId } };
  }
  if (value.kind === 'stop') {
    const identity = parseSystemdIdentity(value.identity);
    if (identity) return { kind: 'stop', identity };
  }
  return null;
}

export function parseSystemdHelperReply(value: unknown): SystemdHelperReply | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'ready' && Object.keys(value).length === 2) {
    const identity = parseSystemdIdentity(value.identity);
    if (identity) return { kind: 'ready', identity };
  }
  if (value.kind === 'stopped' && Object.keys(value).length === 1) return { kind: 'stopped' };
  if (value.kind === 'failed' && Object.keys(value).length === 2
    && FAILURE_CODES.some((code) => code === value.code)) {
    return { kind: 'failed', code: value.code as SystemdContainmentErrorCode };
  }
  return null;
}
