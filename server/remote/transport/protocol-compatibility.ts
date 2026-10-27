import { createHash } from 'node:crypto';
import { isRecord } from '../../../common/json.js';

export interface ProtocolOffer {
  readonly core: number;
  readonly contracts: Readonly<Record<string, readonly number[]>>;
}

export interface ProtocolProfile {
  readonly core: number;
  readonly contracts: Readonly<Record<string, number>>;
}

export type ProtocolDecision =
  | { readonly ok: true; readonly profile: ProtocolProfile }
  | { readonly ok: false; readonly code: 'CORE_MISMATCH' | 'CONTINUITY_MISMATCH' | 'BULK_PROFILE_MISMATCH' };

export interface ProtocolContinuity {
  readonly executorId: string;
  readonly controllerRuntimeId: string;
  readonly workerRuntimeId: string;
  readonly profileId: string;
}

export interface SessionProtocol {
  readonly profile: ProtocolProfile;
  readonly continuity: ProtocolContinuity;
}

export type ProtocolRequirement =
  | { readonly kind: 'core' }
  | { readonly kind: 'contract'; readonly name: string; readonly version: number };

export const EXECUTOR_PROTOCOL: ProtocolOffer = Object.freeze({ core: 1, contracts: Object.freeze({}) });
export const CORE_REQUIREMENT: ProtocolRequirement = Object.freeze({ kind: 'core' });

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isProtocol(value: unknown): value is { core: number; contracts: Record<string, unknown> } {
  return isRecord(value) && Object.keys(value).length === 2
    && Object.hasOwn(value, 'core') && isVersion(value.core)
    && Object.hasOwn(value, 'contracts') && isRecord(value.contracts)
    && Object.keys(value.contracts).length <= 32
    && Object.keys(value.contracts).every(name => /^[a-z][a-z0-9.-]{0,63}$/.test(name));
}

export function isProtocolOffer(value: unknown): value is ProtocolOffer {
  return isProtocol(value) && Object.values(value.contracts).every(versions =>
    Array.isArray(versions) && versions.length >= 1 && versions.length <= 4
    && versions.every(isVersion) && new Set(versions).size === versions.length);
}

export function isProtocolProfile(value: unknown): value is ProtocolProfile {
  return isProtocol(value) && Object.values(value.contracts).every(isVersion);
}

export function isProtocolDecision(value: unknown): value is ProtocolDecision {
  return isRecord(value) && Object.keys(value).length === 2 && Object.hasOwn(value, 'ok')
    && (value.ok === true
      ? Object.hasOwn(value, 'profile') && isProtocolProfile(value.profile)
      : value.ok === false && Object.hasOwn(value, 'code')
        && ['CORE_MISMATCH', 'CONTINUITY_MISMATCH', 'BULK_PROFILE_MISMATCH'].includes(String(value.code)));
}

export function selectProtocol(local: ProtocolOffer, peer: ProtocolOffer): ProtocolDecision {
  if (local.core !== peer.core) return { ok: false, code: 'CORE_MISMATCH' };
  const contracts: Record<string, number> = {};
  for (const name of Object.keys(local.contracts).sort()) {
    if (!Object.hasOwn(peer.contracts, name)) continue;
    const common = local.contracts[name]!.filter(version => peer.contracts[name]!.includes(version));
    if (common.length > 0) contracts[name] = Math.max(...common);
  }
  return { ok: true, profile: Object.freeze({ core: local.core, contracts: Object.freeze(contracts) }) };
}

export function canonicalProfile(profile: ProtocolProfile): string {
  return JSON.stringify([profile.core, Object.keys(profile.contracts).sort().map(name => [name, profile.contracts[name]])]);
}

export function protocolProfileId(profile: ProtocolProfile): string {
  return createHash('sha256').update(canonicalProfile(profile)).digest('hex');
}

export function sameContinuity(left: ProtocolContinuity, right: ProtocolContinuity): boolean {
  return left.executorId === right.executorId
    && left.controllerRuntimeId === right.controllerRuntimeId
    && left.workerRuntimeId === right.workerRuntimeId
    && left.profileId === right.profileId;
}

export function supportsRequirement(profile: ProtocolProfile, requirement: ProtocolRequirement): boolean {
  return requirement.kind === 'core'
    || Object.hasOwn(profile.contracts, requirement.name) && profile.contracts[requirement.name] === requirement.version;
}
