import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AcpJsonRpcId } from '../../acp/protocol.js';
import type { AcpAbortStrategy, AcpAgentPolicy } from './acp-agent-runtime.js';
import type { AcpResumeRequest, AcpStartRequest } from './runtime-types.js';

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function buildPromptFallback(
  request: AcpStartRequest | AcpResumeRequest,
): Array<{ type: string; text: string }> {
  return [{ type: 'text', text: request.command }];
}

export function buildEnvFallback(
  request: AcpStartRequest | AcpResumeRequest,
): Record<string, string | undefined> {
  return { ...process.env, ...request.envOverrides };
}

export function isAutoApproveMode(mode: PermissionMode): boolean {
  return mode === 'acceptEdits' || mode === 'manualBypass' || mode === 'bypassPermissions';
}

export function autoApproveOptionId(mode: PermissionMode): 'allow-once' | 'allow-always' {
  return mode === 'bypassPermissions' ? 'allow-always' : 'allow-once';
}

export function isJsonRpcId(value: unknown): value is AcpJsonRpcId {
  return typeof value === 'number' || typeof value === 'string';
}

function optionIdFrom(option: Record<string, unknown>): string | undefined {
  return asString(option.optionId ?? option.option_id ?? option.id);
}

export function permissionOptionId(
  options: Array<Record<string, unknown>>,
  fallback: string,
): string {
  const optionIds = options.map(optionIdFrom).filter((id): id is string => Boolean(id));
  if (optionIds.includes(fallback)) return fallback;
  return optionIds[0] ?? fallback;
}

export function permissionOutcome(optionId: string): Record<string, unknown> {
  return { outcome: { outcome: 'selected', optionId } };
}

export function permissionCancelledOutcome(): Record<string, unknown> {
  return { outcome: { outcome: 'cancelled' } };
}

export function humanizeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function abortStrategy(policy: AcpAgentPolicy): AcpAbortStrategy {
  return policy.abortStrategy ?? 'cancel';
}
