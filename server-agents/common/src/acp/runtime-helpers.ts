import { UnknownToolUseMessage } from '@garcon/common/chat-types';
import { normalizeToolInput } from '../shared/normalize-util.js';
import type { PermissionMode } from '@garcon/common/chat-modes';
import { asString } from './event-converter.js';
import type { AcpAgentPolicy } from './policy.js';
import type { AcpResumeRequest, AcpStartRequest } from './runtime-types.js';

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

export function automaticPermissionChoice(mode: PermissionMode, kind: unknown, policy: AcpAgentPolicy): AcpPermissionChoice | null {
  if (mode === 'manualBypass' || mode === 'bypassPermissions') return 'auto-approve';
  return mode === 'acceptEdits' && policy.acceptsEditsOnClient && kind === 'edit' ? 'allow-once' : null;
}

// `auto-approve` is Garcon's bypass policy for the turn: it prefers the
// one-time option so no persistent grant is written, and takes a persistent one
// only when the agent offers nothing else, since bypass means the tool runs.
export type AcpPermissionChoice = 'allow-once' | 'allow-always' | 'auto-approve' | 'reject';
type AcpPermissionResponse = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } };

function optionIdFrom(option: Record<string, unknown>): string | undefined {
  return asString(option.optionId ?? option.option_id ?? option.id);
}

// Option IDs are agent-defined (Antigravity offers `allow` and `deny`), so the
// ACP `kind` decides; the conventional IDs cover agents that omit it. A
// one-time choice never falls back to a persistent grant or a persistent deny
// rule; a persistent grant may narrow to a one-time one.
type ChoiceKind = 'allow_once' | 'allow_always' | 'reject_once';
const CHOICE_KINDS: Record<AcpPermissionChoice, readonly ChoiceKind[]> = {
  'allow-once': ['allow_once'],
  'allow-always': ['allow_always', 'allow_once'],
  'auto-approve': ['allow_once', 'allow_always'],
  reject: ['reject_once'],
};

const UNTYPED_IDS: Record<ChoiceKind, readonly string[]> = {
  allow_once: ['allow-once', 'allow_once', 'allow', 'approve'],
  allow_always: ['allow-always', 'allow_always'],
  reject_once: ['reject-once', 'reject_once', 'reject', 'deny'],
};

// Cancels instead of guessing when no offered option matches, so a denial can
// never select an option whose meaning is unknown.
export function permissionChoiceOutcome(
  options: ReadonlyArray<Record<string, unknown>>,
  choice: AcpPermissionChoice,
): AcpPermissionResponse {
  const untyped = new Set(options.filter((option) => option.kind === undefined).map(optionIdFrom));
  for (const kind of CHOICE_KINDS[choice]) {
    for (const option of options) {
      const id = optionIdFrom(option);
      if (option.kind === kind && id) return permissionOutcome(id);
    }
    const conventional = UNTYPED_IDS[kind].find((id) => untyped.has(id));
    if (conventional) return permissionOutcome(conventional);
  }
  return permissionCancelledOutcome();
}

export function permissionOutcome(optionId: string): AcpPermissionResponse {
  return { outcome: { outcome: 'selected', optionId } };
}

export function permissionCancelledOutcome(): AcpPermissionResponse {
  return { outcome: { outcome: 'cancelled' } };
}

export function humanizeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
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

// Runs `onTimeout` if `settled` has not resolved within `ms`.
export function unlessSettled(settled: Promise<void>, ms: number, onTimeout: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(onTimeout, ms);
  timer.unref?.();
  void settled.then(() => clearTimeout(timer));
  return timer;
}
