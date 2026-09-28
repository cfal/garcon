import {
  isAgentResourceRef,
  type AgentPermissionLifecycle,
  type AgentPermissionResponseCapability,
} from '@garcon/server-agent-interface';
import type { LedgerPermissionRow } from './contracts.js';

export function validatePermissionDecision(
  lifecycle: Extract<AgentPermissionLifecycle, { readonly kind: 'requested' }>,
  capability: AgentPermissionResponseCapability,
): AgentPermissionResponseCapability {
  if (
    !capability
    || capability.permissionOccurrenceId !== lifecycle.permissionOccurrenceId
    || !isAgentResourceRef(capability.response, 'permission-response')
  ) {
    throw new TypeError('Permission response capability does not match its request occurrence');
  }
  return capability;
}

export function permissionRowKind(
  lifecycle: Exclude<AgentPermissionLifecycle, { readonly kind: 'resolved' }>,
): LedgerPermissionRow['kind'] {
  return `permission-${lifecycle.kind}`;
}
