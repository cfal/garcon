import crypto from 'node:crypto';
import type { ChatMessage } from '@garcon/common/chat-types';
import { isRecord } from '@garcon/common/json';
import {
  AgentIntegrationError,
  orderedTranscriptDigest,
} from '@garcon/server-agent-interface';
import type {
  ForkTranscriptEntryContext,
  ForkTranscriptTransformInput,
  ForkTranscriptTransformResult,
} from '@garcon/server-agent-common/forking/fork-jsonl';
import { convertClaudeEntries, sortClaudeEntries } from './history-loader.js';

const CLAUDE_TRANSCRIPT_TYPES = new Set([
  'user',
  'assistant',
  'attachment',
  'system',
  'progress',
]);
const CLAUDE_SOURCE_ONLY_FIELDS = [
  'teamName',
  'agentName',
  'slug',
  'sourceToolAssistantUUID',
] as const;

interface ClaudeForkTransformerOptions {
  readonly randomUUID?: () => string;
  readonly now?: () => string;
}

export function projectClaudeForkEntry(
  entry: unknown,
  context: ForkTranscriptEntryContext,
): unknown {
  if (!isRecord(entry)) return entry;
  const retainedMessageCount = context.retainedMessageCount;
  if (retainedMessageCount === undefined) return entry;

  const emittedCount = convertClaudeEntries([entry]).length;
  if (emittedCount <= retainedMessageCount) return entry;
  if (retainedMessageCount === 0) return { ...entry, isMeta: true };

  const message = isRecord(entry.message) ? entry.message : null;
  const content = message?.content;
  if (!message || !Array.isArray(content)) {
    throw new Error('Claude fork cutoff cannot split the selected provider entry');
  }

  if (message.role === 'user') {
    const toolResults = content.filter((part) => isRecord(part) && part.type === 'tool_result');
    if (retainedMessageCount <= toolResults.length) {
      return {
        ...entry,
        message: { ...message, content: toolResults.slice(0, retainedMessageCount) },
      };
    }
  }

  if (message.role === 'assistant') {
    for (let index = 0; index < content.length; index += 1) {
      const candidate = {
        ...entry,
        message: { ...message, content: content.slice(0, index + 1) },
      };
      if (convertClaudeEntries([candidate]).length === retainedMessageCount) return candidate;
    }
  }

  throw new Error('Claude fork cutoff cannot preserve the selected provider entry prefix');
}

export function createClaudeForkTranscriptTransformer(
  options: ClaudeForkTransformerOptions = {},
): (input: ForkTranscriptTransformInput) => ForkTranscriptTransformResult {
  const randomUUID = options.randomUUID ?? crypto.randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  // Mirrors the graph rewrite used by the official Claude Agent SDK filesystem fork.
  return (input) => {
    const forkTimestamp = now();
    const transcript = input.selectedEntries
      .filter(isClaudeTranscriptEntry)
      .filter((entry) => entry.isSidechain !== true);
    const byUuid = new Map(transcript.map((entry) => [entry.uuid as string, entry]));
    const uuidMap = new Map(transcript.map((entry) => [entry.uuid as string, randomUUID()]));
    const writtenSourceUuids = new Set<string>();
    const messages = transcript
      .filter((entry) => entry.type !== 'progress')
      .map((entry) => {
        const sourceUuid = entry.uuid as string;
        const rewritten: Record<string, unknown> = {
          ...entry,
          uuid: uuidMap.get(sourceUuid)!,
          parentUuid: remapClaudeParent(
            stringOrNull(entry.parentUuid),
            byUuid,
            uuidMap,
            writtenSourceUuids,
          ),
          sessionId: input.targetAgentSessionId,
          isSidechain: false,
          forkedFrom: {
            sessionId: input.sourceAgentSessionId,
            messageUuid: sourceUuid,
          },
        };
        if (typeof entry.logicalParentUuid === 'string' && uuidMap.has(entry.logicalParentUuid)) {
          rewritten.logicalParentUuid = uuidMap.get(entry.logicalParentUuid)!;
        }
        if (entry.session_id === input.sourceAgentSessionId) {
          rewritten.session_id = input.targetAgentSessionId;
        }
        for (const field of CLAUDE_SOURCE_ONLY_FIELDS) delete rewritten[field];
        writtenSourceUuids.add(sourceUuid);
        return rewritten;
      });

    if (messages.length > 0) {
      messages[messages.length - 1] = { ...messages[messages.length - 1], timestamp: forkTimestamp };
    }
    const entries: Record<string, unknown>[] = [...messages];
    const replacements = input.sourceEntries
      .filter(isRecord)
      .filter((entry) => entry.type === 'content-replacement'
        && entry.sessionId === input.sourceAgentSessionId
        && Array.isArray(entry.replacements))
      .flatMap((entry) => entry.replacements as unknown[]);
    if (replacements.length > 0) {
      entries.push({
        type: 'content-replacement',
        uuid: randomUUID(),
        timestamp: forkTimestamp,
        sessionId: input.targetAgentSessionId,
        replacements,
      });
    }

    assertClaudeForkGraph(
      entries,
      input.sourceEntries.filter(isClaudeTranscriptEntry),
      input.targetAgentSessionId,
    );
    return {
      entries,
      expectedSemanticDigest: claudeForkSemanticDigest(projectClaudeForkMessages(entries)),
    };
  };
}

export const transformClaudeForkTranscript = createClaudeForkTranscriptTransformer();

export function claudeForkSemanticDigest(messages: readonly ChatMessage[]): string {
  return orderedTranscriptDigest(messages.map((message, index) => ({
    seq: index + 1,
    message: { ...message, timestamp: '' } as ChatMessage,
  })));
}

function projectClaudeForkMessages(entries: readonly Record<string, unknown>[]): ChatMessage[] {
  return convertClaudeEntries(sortClaudeEntries([...entries]));
}

function isClaudeTranscriptEntry(entry: unknown): entry is Record<string, unknown> & { uuid: string } {
  return isRecord(entry)
    && typeof entry.uuid === 'string'
    && typeof entry.type === 'string'
    && CLAUDE_TRANSCRIPT_TYPES.has(entry.type);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function remapClaudeParent(
  parentUuid: string | null,
  byUuid: ReadonlyMap<string, Record<string, unknown>>,
  uuidMap: ReadonlyMap<string, string>,
  writtenSourceUuids: ReadonlySet<string>,
): string | null {
  const visited = new Set<string>();
  let current = parentUuid;
  while (current && !visited.has(current)) {
    visited.add(current);
    const parent = byUuid.get(current);
    if (!parent) return null;
    if (parent.type !== 'progress') {
      if (!writtenSourceUuids.has(current)) {
        throw unavailable('Claude transcript parent appears after its child');
      }
      return uuidMap.get(current) ?? null;
    }
    current = stringOrNull(parent.parentUuid);
  }
  return null;
}

function assertClaudeForkGraph(
  entries: readonly Record<string, unknown>[],
  sourceEntries: readonly (Record<string, unknown> & { uuid: string })[],
  targetSessionId: string,
): void {
  const sourceUuids = new Set(sourceEntries.map((entry) => entry.uuid));
  const writtenUuids = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'content-replacement') continue;
    if (typeof entry.uuid !== 'string' || writtenUuids.has(entry.uuid) || sourceUuids.has(entry.uuid)) {
      throw unavailable('Claude fork did not create independent message identities');
    }
    if (entry.sessionId !== targetSessionId) {
      throw unavailable('Claude fork contains inconsistent session identity');
    }
    if (entry.parentUuid !== null && !writtenUuids.has(String(entry.parentUuid))) {
      throw unavailable('Claude fork contains an invalid parent graph');
    }
    writtenUuids.add(entry.uuid);
  }
}

function unavailable(message: string): AgentIntegrationError {
  return new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', message, false);
}
