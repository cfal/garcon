import crypto from 'crypto';
import {
  BashToolUseMessage,
  EditToolUseMessage,
  PermissionCancelledMessage,
  PermissionRequestMessage,
  RequestPermissionsToolUseMessage,
} from '@garcon/common/chat-types';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { publishPermissionCancelled, type CodexOperation } from './operation-routes.js';
import type { JsonRpcId, JsonRpcServerRequest } from './protocol.js';

export interface CodexPendingApproval {
  permissionOccurrenceId: string;
  requestId: JsonRpcId;
  chatId: string;
  method: string;
  params: Record<string, unknown>;
}

export function isApprovalRequest(request: JsonRpcServerRequest): boolean {
  return [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ].includes(request.method);
}

export function createPendingApproval(chatId: string, request: JsonRpcServerRequest): CodexPendingApproval {
  return {
    permissionOccurrenceId: crypto.randomUUID(),
    requestId: request.id,
    chatId,
    method: request.method,
    params: asObject(request.params),
  };
}

export function buildApprovalMessage(pending: CodexPendingApproval): PermissionRequestMessage {
  const now = new Date().toISOString();
  const toolId = stringField(pending.params.itemId)
    || stringField(pending.params.callId)
    || pending.permissionOccurrenceId;

  if (pending.method === 'item/commandExecution/requestApproval') {
    const command = stringField(pending.params.command)
      || networkApprovalLabel(pending.params.networkApprovalContext)
      || stringField(pending.params.reason)
      || 'Command approval requested';
    return new PermissionRequestMessage(
      now,
      pending.permissionOccurrenceId,
      new BashToolUseMessage(now, toolId, command),
    );
  }

  if (pending.method === 'execCommandApproval') {
    const command = Array.isArray(pending.params.command)
      ? pending.params.command.map(String).join(' ')
      : stringField(pending.params.reason) || 'Command approval requested';
    return new PermissionRequestMessage(
      now,
      pending.permissionOccurrenceId,
      new BashToolUseMessage(now, toolId, command),
    );
  }

  if (pending.method === 'item/fileChange/requestApproval' || pending.method === 'applyPatchApproval') {
    return new PermissionRequestMessage(
      now,
      pending.permissionOccurrenceId,
      new EditToolUseMessage(now, toolId),
    );
  }

  return new PermissionRequestMessage(
    now,
    pending.permissionOccurrenceId,
    new RequestPermissionsToolUseMessage(
      now,
      toolId,
      asObject(pending.params.permissions),
      stringField(pending.params.reason),
    ),
  );
}

export function buildApprovalResponse(
  pending: CodexPendingApproval,
  decision: { allow: boolean; alwaysAllow?: boolean },
): unknown {
  if (pending.method === 'item/commandExecution/requestApproval') {
    return { decision: commandDecision(decision) };
  }

  if (pending.method === 'item/fileChange/requestApproval') {
    return { decision: fileChangeDecision(decision) };
  }

  if (pending.method === 'item/permissions/requestApproval') {
    return {
      permissions: decision.allow ? grantedPermissionProfile(pending.params.permissions) : {},
      scope: decision.allow && decision.alwaysAllow ? 'session' : 'turn',
    };
  }

  if (pending.method === 'execCommandApproval' || pending.method === 'applyPatchApproval') {
    return { decision: historicalReviewDecision(decision) };
  }

  return {};
}

function commandDecision(decision: { allow: boolean; alwaysAllow?: boolean }): string {
  if (!decision.allow) return 'decline';
  return decision.alwaysAllow ? 'acceptForSession' : 'accept';
}

function fileChangeDecision(decision: { allow: boolean; alwaysAllow?: boolean }): string {
  if (!decision.allow) return 'decline';
  return decision.alwaysAllow ? 'acceptForSession' : 'accept';
}

function historicalReviewDecision(decision: { allow: boolean; alwaysAllow?: boolean }): string {
  if (!decision.allow) return 'denied';
  return decision.alwaysAllow ? 'approved_for_session' : 'approved';
}

function grantedPermissionProfile(raw: unknown): Record<string, unknown> {
  const request = asObject(raw);
  const granted: Record<string, unknown> = {};
  if (request.network) granted.network = request.network;
  if (request.fileSystem) granted.fileSystem = request.fileSystem;
  return granted;
}

function networkApprovalLabel(raw: unknown): string | null {
  const context = asObject(raw);
  const host = stringField(context.host);
  const protocol = stringField(context.protocol);
  if (!host) return null;
  return protocol ? `Network access to ${protocol}://${host}` : `Network access to ${host}`;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// Each approval belongs to the operation that provoked it, so its cancellation is published
// through that operation rather than batched behind whichever one happens to be current.
export function cancelPendingApprovals(
  logger: AgentLogger,
  pending: Set<CodexPendingApproval & { client: object; operation: CodexOperation }>,
  client: object,
  reason: 'cancelled' | 'session-complete' | 'aborted',
): void {
  for (const approval of [...pending]) {
    if (approval.client !== client) continue;
    pending.delete(approval);
    publishPermissionCancelled(
      logger,
      approval.chatId,
      new PermissionCancelledMessage(
        new Date().toISOString(),
        approval.permissionOccurrenceId,
        reason,
      ),
      approval.operation,
    );
  }
}
