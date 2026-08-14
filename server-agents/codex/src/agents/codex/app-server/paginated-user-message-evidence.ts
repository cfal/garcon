import type { ChatMessage } from '@garcon/common/chat-types';
import { parseFirstJsonlValue } from '@garcon/server-agent-common/lib/jsonl';
import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { convertCodexAppServerItem } from './converter.js';
import type { CodexThreadItem, CodexUserInput } from './protocol.js';

export interface CodexPaginatedItemEvidence {
  readonly messages: ChatMessage[];
  readonly orderedItemIdsByTurn: ReadonlyMap<string, readonly string[]>;
}

export async function loadPaginatedUserMessageEvidence(
  nativePath: string,
  fallbackTimestamp: string,
  signal: AbortSignal,
  survivingTurnIds: ReadonlySet<string>,
): Promise<CodexPaginatedItemEvidence> {
  // Pinned Codex persists ItemCompleted user messages but omits them from terminal
  // history reconstruction: https://github.com/openai/codex/blob/5d1fbf26c43abc65a203928b2e31561cb039e06d/codex-rs/rollout/src/policy.rs#L86-L93
  // and https://github.com/openai/codex/blob/5d1fbf26c43abc65a203928b2e31561cb039e06d/codex-rs/app-server-protocol/src/protocol/thread_history.rs#L586-L622
  const messages: ChatMessage[] = [];
  const orderedItemIdsByTurn = new Map<string, string[]>();
  for await (const entry of readJsonlLineEntries(nativePath, { signal })) {
    const parsed = parseFirstJsonlValue<unknown>(entry.line);
    if (parsed.kind !== 'value') continue;
    const rollout = record(parsed.value);
    const payload = record(rollout?.payload);
    const item = record(payload?.item);
    const turnId =
      nonEmptyString(payload?.turn_id) ?? nonEmptyString(payload?.turnId);
    if (
      rollout?.type !== 'event_msg' ||
      payload?.type !== 'item_completed' ||
      !turnId ||
      !survivingTurnIds.has(turnId)
    ) {
      continue;
    }
    if (!item) continue;

    const id = nonEmptyString(item.id);
    if (!id) continue;
    const orderedIds = orderedItemIdsByTurn.get(turnId) ?? [];
    if (orderedIds.includes(id)) continue;
    orderedIds.push(id);
    orderedItemIdsByTurn.set(turnId, orderedIds);
    if (item.type !== 'UserMessage' && item.type !== 'userMessage') continue;
    const clientId =
      nonEmptyString(item.client_id) ?? nonEmptyString(item.clientId);
    if (!clientId || !Array.isArray(item.content)) continue;
    const threadItem: CodexThreadItem = {
      type: 'userMessage',
      id,
      clientId,
      content: item.content as CodexUserInput[],
    };
    const timestamp = codexEvidenceTimestamp(
      payload.completed_at_ms,
      rollout.timestamp,
      fallbackTimestamp,
    );
    convertCodexAppServerItem(threadItem, timestamp, {
      includeUserMessages: true,
    }).forEach((message, withinSourceOrdinal) => {
      messages.push(
        attachNativeMessageSource(message, {
          entryId: `turn:${turnId}:item:${id}`,
          byteOffset: entry.byteOffset,
          lineNumber: entry.lineNumber,
          withinSourceOrdinal,
        }),
      );
    });
  }
  return { messages, orderedItemIdsByTurn };
}

function codexEvidenceTimestamp(
  completedAtMs: unknown,
  rolloutTimestamp: unknown,
  fallback: string,
): string {
  if (
    typeof completedAtMs === 'number' &&
    Number.isFinite(completedAtMs) &&
    completedAtMs > 0
  ) {
    const timestamp = new Date(completedAtMs);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
  }
  if (
    typeof rolloutTimestamp === 'string' &&
    !Number.isNaN(Date.parse(rolloutTimestamp))
  ) {
    return rolloutTimestamp;
  }
  return fallback;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
