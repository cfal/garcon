import { UnknownToolUseMessage } from '@garcon/common/chat-types';
import { normalizeToolInput } from '../shared/normalize-util.js';
import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AcpJsonRpcId } from './protocol.js';
import { asString } from './event-converter.js';
import type { AcpAbortStrategy, AcpAgentPolicy } from './policy.js';
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

export const DEFAULT_AUTO_APPROVE_MODES: readonly PermissionMode[] = ['acceptEdits', 'manualBypass', 'bypassPermissions'];

export function isAutoApproveMode(mode: PermissionMode, policy: AcpAgentPolicy): boolean {
  return (policy.autoApprovePermissionModes ?? DEFAULT_AUTO_APPROVE_MODES).includes(mode);
}

// `auto-approve` is Garcon's bypass policy for the turn: it prefers the
// one-time option so no persistent grant is written, and takes a persistent one
// only when the agent offers nothing else, since bypass means the tool runs.
export type AcpPermissionChoice = 'allow-once' | 'allow-always' | 'auto-approve' | 'reject';

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
  'auto-approve': ['allow_once', 'allow_always'],
  reject: ['reject_once'],
};

const CHOICE_FALLBACK_IDS: Record<AcpPermissionChoice, readonly string[]> = {
  'allow-once': ['allow-once', 'allow_once', 'allow', 'approve'],
  'allow-always': ['allow-always', 'allow_always', 'allow-once', 'allow_once', 'allow', 'approve'],
  'auto-approve': ['allow-once', 'allow_once', 'allow', 'approve', 'allow-always', 'allow_always'],
  reject: ['reject-once', 'reject_once', 'reject', 'deny'],
};

// Cancels instead of guessing when no offered option matches, so a denial can
// never select an option whose meaning is unknown. An agent that offers no
// options at all gets the conventional ID for the choice.
export function permissionChoiceOutcome(
  options: ReadonlyArray<Record<string, unknown>>,
  choice: AcpPermissionChoice,
): Record<string, unknown> {
  if (options.length === 0) return permissionOutcome(CHOICE_FALLBACK_IDS[choice][0]!);
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

// A follow-up waiting on a stopped turn stops waiting once its own admission closes.
export function untilSettledOrClosed(settled: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return settled;
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    void settled.then(done);
  });
}

// Runs `onTimeout` if `settled` has not resolved within `ms`.
export function unlessSettled(settled: Promise<void>, ms: number, onTimeout: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(onTimeout, ms);
  timer.unref?.();
  void settled.then(() => clearTimeout(timer));
  return timer;
}
