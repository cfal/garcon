import crypto from 'node:crypto';
import type { ChatMessage } from '@garcon/common/chat-types';
import { isRecord } from '@garcon/common/json';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import { OrderedTranscriptDigest } from '@garcon/server-agent-common/forking/transcript-digest';
import type {
  ForkTranscriptEntryContext,
  ForkTranscriptTransformInput,
  ForkTranscriptTransformResult,
} from '@garcon/server-agent-common/forking/fork-jsonl';
import { convertClaudeEntries, convertClaudeEntriesInSteps, sortClaudeEntriesInSteps } from './history-loader.js';
import { claudeSteeringInputsFromNativeContent } from './user-input.js';

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
// Task-identity keys the CLI 2.1.220 resume scanner uses to reconstruct
// outstanding background work from the transcript. A fork's fresh session
// cannot own the source's tasks, so copying these makes the child's first
// resume synthesize an orphaned-task "stopped" notification. Verified live:
// stripping backgroundTaskId alone silences the scanner; run_in_background
// in the tool_use input does not participate. outputTaskId is stripped as
// task identity on the same rationale; descriptive fields stay.
const CLAUDE_TASK_ACTIVATION_FIELDS = ['backgroundTaskId', 'outputTaskId'] as const;

type ClaudeTranscriptEntry = Record<string, unknown> & { uuid: string };

interface ClaudeForkTransformerOptions {
  readonly randomUUID?: () => string;
  readonly now?: () => string;
}

function stripTaskActivation(rewritten: Record<string, unknown>): void {
  const toolUseResult = rewritten.toolUseResult;
  if (!isRecord(toolUseResult)) return;
  if (!CLAUDE_TASK_ACTIVATION_FIELDS.some((field) => field in toolUseResult)) return;
  const projected = { ...toolUseResult };
  for (const field of CLAUDE_TASK_ACTIVATION_FIELDS) delete projected[field];
  rewritten.toolUseResult = projected;
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
    const steeringInputs = claudeSteeringInputsFromNativeContent(content);
    if (steeringInputs && retainedMessageCount <= steeringInputs.length) {
      return {
        ...entry,
        message: { ...message, content: content.slice(0, retainedMessageCount) },
      };
    }
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
): (input: ForkTranscriptTransformInput) => Promise<ForkTranscriptTransformResult> {
  const randomUUID = options.randomUUID ?? crypto.randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  // The Agent SDK indexes the full selected graph before resolving parent links, so
  // parentUuid may refer to a record that appears later in physical JSONL order.
  // https://github.com/anthropics/claude-agent-sdk-python/blob/f8b9ec923982082a02c485924e0f60367949c3a1/src/claude_agent_sdk/_internal/session_mutations.py#L385-L418
  return async (input) => {
    const steps = new EventLoopSteps('claude-fork-transform');
    const forkTimestamp = now();
    const transcript: ClaudeTranscriptEntry[] = [];
    await steps.forEach(input.selectedEntries, (entry) => {
      if (isClaudeTranscriptEntry(entry) && entry.isSidechain !== true) transcript.push(entry);
    });
    const byUuid = new Map<string, Record<string, unknown>>();
    const uuidMap = new Map<string, string>();
    await steps.forEach(transcript, (entry) => {
      byUuid.set(entry.uuid, entry);
      uuidMap.set(entry.uuid, randomUUID());
    });
    const entries: Record<string, unknown>[] = [];
    await steps.forEach(transcript, (entry) => {
      if (entry.type === 'progress') return;
      const sourceUuid = entry.uuid;
      const rewritten: Record<string, unknown> = {
        ...entry,
        uuid: uuidMap.get(sourceUuid)!,
        parentUuid: remapClaudeParent(
          stringOrNull(entry.parentUuid),
          byUuid,
          uuidMap,
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
      stripTaskActivation(rewritten);
      entries.push(rewritten);
    });

    if (entries.length > 0) {
      entries[entries.length - 1] = { ...entries[entries.length - 1], timestamp: forkTimestamp };
    }
    // Microcompaction re-appends retained entries with their original uuids
    // (rechained via parentUuid), so a source uuid can legitimately occur more
    // than once. The copy preserves that structure faithfully; the graph
    // assertion permits each target uuid exactly the source's multiplicity.
    const allowedUuidCounts = new Map<string, number>();
    await steps.forEach(transcript, (entry) => {
      if (entry.type === 'progress') return;
      const target = uuidMap.get(entry.uuid)!;
      allowedUuidCounts.set(target, (allowedUuidCounts.get(target) ?? 0) + 1);
    });
    const replacements: unknown[] = [];
    const sourceUuids = new Set<string>();
    await steps.forEach(input.sourceEntries, (entry) => {
      if (isClaudeTranscriptEntry(entry)) sourceUuids.add(entry.uuid);
      if (
        isRecord(entry)
        && entry.type === 'content-replacement'
        && entry.sessionId === input.sourceAgentSessionId
        && Array.isArray(entry.replacements)
      ) {
        for (const replacement of entry.replacements) replacements.push(replacement);
      }
    });
    if (replacements.length > 0) {
      entries.push({
        type: 'content-replacement',
        uuid: randomUUID(),
        timestamp: forkTimestamp,
        sessionId: input.targetAgentSessionId,
        replacements,
      });
    }

    await assertClaudeForkGraph(
      entries,
      sourceUuids,
      input.targetAgentSessionId,
      allowedUuidCounts,
      steps,
    );
    const forkedMessages = await projectClaudeForkMessages(entries, steps);
    return { entries, expectedSemanticDigest: await semanticDigest(forkedMessages, steps) };
  };
}

export const transformClaudeForkTranscript = createClaudeForkTranscriptTransformer();

export function claudeForkSemanticDigest(messages: readonly ChatMessage[]): Promise<string> {
  return semanticDigest(messages, new EventLoopSteps('claude-fork-digest'));
}

async function semanticDigest(messages: readonly ChatMessage[], steps: EventLoopSteps): Promise<string> {
  const digest = new OrderedTranscriptDigest();
  await steps.forEach(messages, (message) => { digest.add(claudeForkSemanticMessage(message)); });
  return digest.digest();
}

function claudeForkSemanticMessage(message: ChatMessage): ChatMessage {
  if (message.type !== 'user-message') return { ...message, timestamp: '' } as ChatMessage;
  const { upstreamRequestId: _nativeInputUuid, ...metadata } = message.metadata ?? {};
  return {
    ...message,
    timestamp: '',
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

async function projectClaudeForkMessages(
  entries: readonly Record<string, unknown>[],
  steps: EventLoopSteps,
): Promise<ChatMessage[]> {
  return convertClaudeEntriesInSteps(await sortClaudeEntriesInSteps(entries, steps), steps);
}

function isClaudeTranscriptEntry(entry: unknown): entry is ClaudeTranscriptEntry {
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
): string | null {
  const visited = new Set<string>();
  let current = parentUuid;
  while (current && !visited.has(current)) {
    visited.add(current);
    const parent = byUuid.get(current);
    if (!parent) return null;
    if (parent.type !== 'progress') {
      return uuidMap.get(current) ?? null;
    }
    current = stringOrNull(parent.parentUuid);
  }
  return null;
}

async function assertClaudeForkGraph(
  entries: readonly Record<string, unknown>[],
  sourceUuids: ReadonlySet<string>,
  targetSessionId: string,
  allowedUuidCounts: ReadonlyMap<string, number>,
  steps: EventLoopSteps,
): Promise<void> {
  // The Agent SDK resolves parents from its complete UUID map rather than treating file
  // order as a topological order. Validation therefore checks closure over all emitted nodes.
  // https://github.com/anthropics/claude-agent-sdk-python/blob/f8b9ec923982082a02c485924e0f60367949c3a1/src/claude_agent_sdk/_internal/session_mutations.py#L396-L418
  const emittedUuids = new Set<string>();
  await steps.forEach(entries, (entry) => {
    if (entry.type !== 'content-replacement' && typeof entry.uuid === 'string') emittedUuids.add(entry.uuid);
  });
  const emittedUuidCounts = new Map<string, number>();
  await steps.forEach(entries, (entry) => {
    if (entry.type === 'content-replacement') return;
    if (typeof entry.uuid !== 'string' || sourceUuids.has(entry.uuid)) {
      throw unavailable('Claude fork did not create independent message identities');
    }
    const emitted = (emittedUuidCounts.get(entry.uuid) ?? 0) + 1;
    if (emitted > (allowedUuidCounts.get(entry.uuid) ?? 1)) {
      throw unavailable('Claude fork did not create independent message identities');
    }
    emittedUuidCounts.set(entry.uuid, emitted);
    if (entry.sessionId !== targetSessionId) {
      throw unavailable('Claude fork contains inconsistent session identity');
    }
    if (entry.parentUuid !== null && !emittedUuids.has(String(entry.parentUuid))) {
      throw unavailable('Claude fork contains an invalid parent graph');
    }
  });
}

function unavailable(message: string): AgentIntegrationError {
  return new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', message, false);
}
