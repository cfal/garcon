import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, type ChatMessage } from '@garcon/common/chat-types';
import {
  agentOwnershipEpoch,
  attachNativeMessageSource,
  type AgentChatReferenceV4,
  type AgentTranscriptEntry,
} from '@garcon/server-agent-interface';
import { sourceIdentityKey } from './identity.js';
import { JournalBackedAgentTranscriptStream, transcriptSeedEntries } from './journal-stream.js';

// Deterministic projection conformance kit. Every integration mounts the same
// journal engine, so its shared identity contract is provable without spawning
// the provider: an adapter wires this in with its owner id and the engine
// upholds INV-5 explicit identity, canonical item plus semantic subrow
// expansion, restart/reopen parity, byte-identical serving, and
// repeated-notification idempotency under that provider's native namespace.
// Provider-specific translation into these source identities stays covered by
// each adapter's converter tests; this proves the engine every adapter relies
// on never collapses equal content, splits one item, or mutates a committed
// envelope across a restart audit.

const EQUAL_CONTENT = 'projection-conformance equal content occurrence';

export interface ProjectionConformanceOptions {
  // The provider's native-namespace owner id, e.g. 'claude' or 'codex'.
  readonly ownerId: string;
}

function conformanceChat(ownerId: string): AgentChatReferenceV4 {
  return {
    chatId: 'projection-conformance-chat',
    agentId: ownerId,
    agentOwnershipEpoch: agentOwnershipEpoch('projection-conformance-ownership'),
    agentSessionId: 'projection-conformance-session',
    projectPath: '/workspace',
    model: 'projection-conformance-model',
    nativeSession: null,
    carryOverRevision: 'projection-conformance-carry',
    nativeSeedReceipt: null,
    settings: { ownerId, schemaVersion: 1, values: {} },
  };
}

// One finalized native occurrence: a rendered row carrying the canonical
// (entryId, withinSourceOrdinal) source every adapter ultimately attaches.
function occurrence(entryId: string, content: string, withinSourceOrdinal = 0): ChatMessage {
  return attachNativeMessageSource(
    new AssistantMessage('2026-06-01T00:00:00.000Z', content),
    { entryId, withinSourceOrdinal },
  );
}

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-projection-conformance-'));
  try {
    return await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// A fresh stream over the same directory models a process restart: stream
// state is process local and only the persisted journal survives, so a second
// open re-audits it against the native evidence rather than re-importing.
function streamFor(ownerId: string, directory: string, native: readonly ChatMessage[]) {
  return new JournalBackedAgentTranscriptStream({
    ownerId,
    directory: async () => directory,
    bootstrap: async () => ({
      kind: 'ready' as const,
      value: transcriptSeedEntries(ownerId, [...native]),
    }),
  });
}

async function projectedEntries(
  ownerId: string,
  directory: string,
  native: readonly ChatMessage[],
): Promise<readonly AgentTranscriptEntry[]> {
  const chat = conformanceChat(ownerId);
  const signal = new AbortController().signal;
  const stream = streamFor(ownerId, directory, native);
  const opened = await stream.openSegment({ chat, signal });
  if (opened.kind !== 'ready') {
    throw new Error(`[${ownerId}] projection conformance openSegment expected ready, got ${opened.kind}`);
  }
  const page = await stream.loadPage({
    chat,
    signal,
    limit: 1000,
    beforeOrdinal: null,
    expectedProjection: null,
  });
  if (page.kind !== 'ready') {
    throw new Error(`[${ownerId}] projection conformance loadPage expected ready, got ${page.kind}`);
  }
  return page.page.entries;
}

function durable(entries: readonly AgentTranscriptEntry[]): readonly AgentTranscriptEntry[] {
  return entries.filter((entry) => entry.lifetime === 'durable');
}

function content(entry: AgentTranscriptEntry): string {
  return (entry.message as AssistantMessage).content;
}

// The full serialized envelope: entry id, canonical source key, lifetime, and
// rendered message. Byte-identical serving requires this to be stable across a
// live import and a restart audit.
function envelope(entry: AgentTranscriptEntry): string {
  return JSON.stringify([
    entry.id,
    entry.source ? sourceIdentityKey(entry.source) : null,
    entry.lifetime,
    entry.message,
  ]);
}

// Equal content with distinct native item identities must yield two surviving
// entries whose envelopes are byte-identical across a restart audit, proving
// INV-5 rejects content-based dedup and the audit is idempotent on reopen.
async function assertEqualContentOccurrencesSurvive(ownerId: string): Promise<void> {
  await withDirectory(async (directory) => {
    const native = [occurrence('equal-a', EQUAL_CONTENT), occurrence('equal-b', EQUAL_CONTENT)];
    const live = durable(await projectedEntries(ownerId, directory, native));
    if (live.length !== 2) {
      throw new Error(`[${ownerId}] equal-content occurrences did not both survive live (${live.length})`);
    }
    if (live.some((entry) => content(entry) !== EQUAL_CONTENT)) {
      throw new Error(`[${ownerId}] equal-content occurrence content changed during import`);
    }
    const identities = new Set(live.map((entry) => envelope(entry)));
    if (identities.size !== 2) {
      throw new Error(`[${ownerId}] equal-content occurrences collapsed to one identity`);
    }
    const restart = durable(await projectedEntries(ownerId, directory, native));
    if (restart.length !== 2) {
      throw new Error(`[${ownerId}] restart audit duplicated or dropped equal-content occurrences (${restart.length})`);
    }
    if (live.map(envelope).join('\n') !== restart.map(envelope).join('\n')) {
      throw new Error(`[${ownerId}] live and restart envelopes are not byte-identical`);
    }
  });
}

// One canonical native item rendered as several rows must expand to that many
// entries sharing one item id, each with a distinct semantic subrow id and a
// distinct entry id.
async function assertCanonicalItemExpandsToSubrows(ownerId: string): Promise<void> {
  await withDirectory(async (directory) => {
    const native = [
      occurrence('one-item', 'canonical subrow 0', 0),
      occurrence('one-item', 'canonical subrow 1', 1),
    ];
    const entries = durable(await projectedEntries(ownerId, directory, native));
    if (entries.length !== 2) {
      throw new Error(`[${ownerId}] canonical item did not expand to two subrows (${entries.length})`);
    }
    if (new Set(entries.map((entry) => entry.source?.itemId)).size !== 1) {
      throw new Error(`[${ownerId}] subrows did not share one canonical item id`);
    }
    if (new Set(entries.map((entry) => entry.source?.subrowId)).size !== 2) {
      throw new Error(`[${ownerId}] subrows did not carry distinct subrow ids`);
    }
    if (new Set(entries.map((entry) => entry.id)).size !== 2) {
      throw new Error(`[${ownerId}] subrows collapsed to one entry id`);
    }
  });
}

// Runs the full deterministic projection conformance suite for one provider's
// native namespace. Throws on the first violated invariant.
export async function runProjectionConformance(options: ProjectionConformanceOptions): Promise<void> {
  await assertEqualContentOccurrencesSurvive(options.ownerId);
  await assertCanonicalItemExpandsToSubrows(options.ownerId);
}
