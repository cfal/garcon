import { UnknownToolUseMessage } from '@garcon/common/chat-types';
import { normalizeToolInput } from '../shared/normalize-util.js';
import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AcpJsonRpcId } from './protocol.js';
import type { AcpAbortStrategy, AcpAgentPolicy } from './agent-runtime.js';
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

export const DEFAULT_AUTO_APPROVE_MODES: readonly PermissionMode[] = ['acceptEdits', 'manualBypass', 'bypassPermissions'];

export function isAutoApproveMode(mode: PermissionMode, policy: AcpAgentPolicy): boolean {
  return (policy.autoApprovePermissionModes ?? DEFAULT_AUTO_APPROVE_MODES).includes(mode);
}

export type AcpPermissionChoice = 'allow-once' | 'allow-always' | 'reject';

export function autoApproveChoice(mode: PermissionMode): AcpPermissionChoice {
  return mode === 'bypassPermissions' ? 'allow-always' : 'allow-once';
}

export function isJsonRpcId(value: unknown): value is AcpJsonRpcId {
  return typeof value === 'number' || typeof value === 'string';
}

function optionIdFrom(option: Record<string, unknown>): string | undefined {
  return asString(option.optionId ?? option.option_id ?? option.id);
}

// Option IDs are agent-defined (Antigravity offers `allow` and `deny`), so the
// ACP `kind` decides; the conventional IDs cover agents that omit it. A
// one-time choice never falls back to a persistent grant or a persistent deny
// rule; a persistent grant may narrow to a one-time one.
const CHOICE_KINDS: Record<AcpPermissionChoice, readonly string[]> = {
  'allow-once': ['allow_once'],
  'allow-always': ['allow_always', 'allow_once'],
  reject: ['reject_once'],
};

const CHOICE_FALLBACK_IDS: Record<AcpPermissionChoice, readonly string[]> = {
  'allow-once': ['allow-once', 'allow_once', 'allow', 'approve'],
  'allow-always': ['allow-always', 'allow_always', 'allow-once', 'allow_once', 'allow', 'approve'],
  reject: ['reject-once', 'reject_once', 'reject', 'deny'],
};

// Cancels instead of guessing when no option matches, so a denial can never
// select an option whose meaning is unknown.
export function permissionChoiceOutcome(
  options: ReadonlyArray<Record<string, unknown>>,
  choice: AcpPermissionChoice,
): Record<string, unknown> {
  for (const kind of CHOICE_KINDS[choice]) {
    const optionId = optionIdFrom(options.find((option) => option.kind === kind) ?? {});
    if (optionId) return permissionOutcome(optionId);
  }
  // Untyped options only; a typed option that did not match has another meaning.
  const optionIds = new Set(options.filter((option) => option.kind === undefined).map(optionIdFrom));
  const fallback = CHOICE_FALLBACK_IDS[choice].find((id) => optionIds.has(id));
  return fallback ? permissionOutcome(fallback) : permissionCancelledOutcome();
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

// Describes a permission request the agent's converter does not recognize.
export function fallbackPermissionToolUse(
  toolCall: Record<string, unknown>,
  permissionOccurrenceId: string,
  timestamp: string,
): UnknownToolUseMessage {
  const toolId = asString(toolCall.toolCallId ?? toolCall.callId ?? toolCall.id) ?? permissionOccurrenceId;
  const rawName = asString(toolCall.toolName ?? toolCall.tool_name ?? toolCall.kind ?? toolCall.title ?? toolCall.name) ?? 'Permission';
  const input = normalizeToolInput(toolCall.rawInput ?? toolCall.raw_input ?? toolCall.input ?? toolCall.args);
  if (Object.keys(input).length === 0) {
    if (Array.isArray(toolCall.locations) && toolCall.locations.length > 0) input.locations = toolCall.locations;
    if (Array.isArray(toolCall.content) && toolCall.content.length > 0) input.content = toolCall.content;
    const title = asString(toolCall.title);
    if (title) input.title = title;
  }
  return new UnknownToolUseMessage(timestamp, toolId, rawName, input);
}
