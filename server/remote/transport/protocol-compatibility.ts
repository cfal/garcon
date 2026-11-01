import { createHash } from 'node:crypto';
import { isRecord } from '../../../common/json.js';
import { canonicalProfile, type ProtocolProfile } from '../../../common/protocol-contracts.js';
import type { RoleContracts } from './rpc-registrations.js';

export type ProtocolDecision =
  | { readonly ok: true; readonly profileId: string }
  | { readonly ok: false; readonly code: 'BOOTSTRAP_MISMATCH' | 'CONTINUITY_MISMATCH' | 'BULK_PROFILE_MISMATCH' };

export interface ProtocolContinuity {
  readonly executorId: string;
  readonly controllerRuntimeId: string;
  readonly workerRuntimeId: string;
  readonly profileId: string;
}

export interface SessionProtocol {
  readonly contracts: RoleContracts;
  readonly profile: ProtocolProfile;
  readonly continuity: ProtocolContinuity;
}

export function isProtocolDecision(value: unknown): value is ProtocolDecision {
  return isRecord(value) && Object.keys(value).length === 2 && Object.hasOwn(value, 'ok')
    && (value.ok === true
      ? Object.hasOwn(value, 'profileId') && typeof value.profileId === 'string' && /^[a-f0-9]{64}$/.test(value.profileId)
      : value.ok === false && Object.hasOwn(value, 'code') && typeof value.code === 'string'
        && ['BOOTSTRAP_MISMATCH', 'CONTINUITY_MISMATCH', 'BULK_PROFILE_MISMATCH'].includes(value.code));
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
