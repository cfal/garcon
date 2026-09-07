import crypto from 'crypto';
import {
  BashToolUseMessage,
  EditToolUseMessage,
  PermissionCancelledMessage,
  PermissionRequestMessage,
  RequestPermissionsToolUseMessage,
  WriteStdinToolUseMessage,
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

export type CodexTrackedApproval<TClient extends object> = CodexPendingApproval & {
  client: TClient;
  operation: CodexOperation;
};

export type CodexPendingApprovalRegistry<TClient extends object> = Map<
  TClient,
  Map<JsonRpcId, CodexTrackedApproval<TClient>>
>;

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

  if (pending.method === 'item/commandExecution/requestApproval') {
    const kind = commandApprovalKind(pending);
    const approvalId = stringField(pending.params.approvalId);
    const itemId = stringField(pending.params.itemId);
    if (kind === 'writeStdin') {
      if (!approvalId || !itemId) {
        throw new TypeError('Codex write-stdin approval requires approvalId and itemId');
      }
      const reason = stringField(pending.params.reason);
      return new PermissionRequestMessage(
        now,
        pending.permissionOccurrenceId,
        new WriteStdinToolUseMessage(now, approvalId, {
          itemId,
          ...(reason ? { reason } : {}),
        }),
      );
    }

    const toolId = approvalId || itemId || pending.permissionOccurrenceId;
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
    const toolId = stringField(pending.params.callId)
      || stringField(pending.params.itemId)
      || pending.permissionOccurrenceId;
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
    const toolId = stringField(pending.params.itemId)
      || stringField(pending.params.callId)
      || pending.permissionOccurrenceId;
    return new PermissionRequestMessage(
      now,
      pending.permissionOccurrenceId,
      new EditToolUseMessage(now, toolId),
    );
  }

  const toolId = stringField(pending.params.itemId)
    || stringField(pending.params.callId)
    || pending.permissionOccurrenceId;
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
    if (commandApprovalKind(pending) === 'writeStdin') {
      if (!stringField(pending.params.approvalId)) {
        throw new TypeError('Codex write-stdin approval requires approvalId');
      }
      return { decision: decision.allow ? 'accept' : 'cancel' };
    }
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

export function addPendingApproval<TClient extends object>(
  pending: CodexPendingApprovalRegistry<TClient>,
  approval: CodexTrackedApproval<TClient>,
): boolean {
  const byRequestId = pending.get(approval.client) ?? new Map();
  if (byRequestId.has(approval.requestId)) return false;
  byRequestId.set(approval.requestId, approval);
  pending.set(approval.client, byRequestId);
  return true;
}

export function takePendingApproval<TClient extends object>(
  pending: CodexPendingApprovalRegistry<TClient>,
  client: TClient,
  requestId: JsonRpcId,
  expected?: CodexTrackedApproval<TClient>,
): CodexTrackedApproval<TClient> | null {
  const byRequestId = pending.get(client);
  const approval = byRequestId?.get(requestId);
  if (!approval || (expected && approval !== expected)) return null;
  byRequestId?.delete(requestId);
  if (byRequestId?.size === 0) pending.delete(client);
  return approval;
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

function commandApprovalKind(pending: CodexPendingApproval): 'command' | 'writeStdin' {
  return pending.params.kind === 'writeStdin' ? 'writeStdin' : 'command';
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
  pending: CodexPendingApprovalRegistry<object>,
  client: object,
  reason: 'cancelled' | 'session-complete' | 'aborted',
  respond?: (approval: CodexTrackedApproval<object>) => void,
): void {
  const byRequestId = pending.get(client);
  if (!byRequestId) return;
  pending.delete(client);
  for (const approval of byRequestId.values()) {
    respond?.(approval);
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
