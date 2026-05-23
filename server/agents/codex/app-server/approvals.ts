import crypto from 'crypto';
import {
  BashToolUseMessage,
  EditToolUseMessage,
  PermissionRequestMessage,
  RequestPermissionsToolUseMessage,
} from "../../../../common/chat-types.js";
import type { JsonRpcServerRequest } from './protocol.js';

export interface CodexPendingApproval {
  permissionRequestId: string;
  requestId: number;
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
    permissionRequestId: `codex-${crypto.randomBytes(8).toString('hex')}`,
    requestId: request.id,
    chatId,
    method: request.method,
    params: asObject(request.params),
  };
}

export function buildApprovalMessage(pending: CodexPendingApproval): PermissionRequestMessage {
  const now = new Date().toISOString();
  const toolId = stringField(pending.params.itemId) || stringField(pending.params.callId) || pending.permissionRequestId;

  if (pending.method === 'item/commandExecution/requestApproval') {
    const command = stringField(pending.params.command)
      || networkApprovalLabel(pending.params.networkApprovalContext)
      || stringField(pending.params.reason)
      || 'Command approval requested';
    return new PermissionRequestMessage(now, pending.permissionRequestId, new BashToolUseMessage(now, toolId, command));
  }

  if (pending.method === 'execCommandApproval') {
    const command = Array.isArray(pending.params.command)
      ? pending.params.command.map(String).join(' ')
      : stringField(pending.params.reason) || 'Command approval requested';
    return new PermissionRequestMessage(now, pending.permissionRequestId, new BashToolUseMessage(now, toolId, command));
  }

  if (pending.method === 'item/fileChange/requestApproval' || pending.method === 'applyPatchApproval') {
    return new PermissionRequestMessage(now, pending.permissionRequestId, new EditToolUseMessage(now, toolId));
  }

  return new PermissionRequestMessage(
    now,
    pending.permissionRequestId,
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
    return { decision: legacyReviewDecision(decision) };
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

function legacyReviewDecision(decision: { allow: boolean; alwaysAllow?: boolean }): string {
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
