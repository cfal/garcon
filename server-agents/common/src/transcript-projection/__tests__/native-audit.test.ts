import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserMessage, type ChatMessage } from '@garcon/common/chat-types';
import {
  AgentIntegrationError,
  agentOwnershipEpoch,
  attachNativeMessageSource,
  type AgentChatReferenceV4,
  type AgentForkPoint,
  type AgentTranscriptEntryId,
} from '@garcon/server-agent-interface';
import {
  JournalBackedAgentTranscriptStream,
  transcriptSeedEntries,
} from '../journal-stream.js';

const temporaryDirectories: string[] = [];
const signal = () => new AbortController().signal;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const chat: AgentChatReferenceV4 = {
  chatId: 'chat-1',
  agentId: 'test',
  agentOwnershipEpoch: agentOwnershipEpoch('ownership-1'),
  agentSessionId: 'session-1',
  projectPath: '/workspace',
  model: 'model-1',
  nativeSession: null,
  carryOverRevision: 'carry-1',
  nativeSeedReceipt: null,
  settings: { ownerId: 'test', schemaVersion: 1, values: {} },
};

function nativeMessage(itemId: string, content: string): ChatMessage {
  const line = Number(itemId.split('-').at(-1));
  return attachNativeMessageSource(
    new UserMessage('2026-06-01T00:00:00.000Z', content),
    { entryId: itemId, lineNumber: line, withinSourceOrdinal: 0 },
  );
}

async function createDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-native-audit-'));
  temporaryDirectories.push(directory);
  return directory;
}

// A fresh stream per open models process restart: stream state is process
// local and only the journal survives.
function streamOver(directory: string, native: () => ChatMessage[] | Promise<ChatMessage[]>) {
  return new JournalBackedAgentTranscriptStream({
    ownerId: 'test',
    directory: async () => directory,
    bootstrap: async () => {
      try {
        return { kind: 'ready', value: transcriptSeedEntries('test', await native()) };
      } catch (error) {
        if (error instanceof AgentIntegrationError) {
          return { kind: 'degraded', errorCode: error.code, retryable: error.retryable };
        }
        throw error;
      }
    },
  });
}

async function openContents(stream: JournalBackedAgentTranscriptStream) {
  const opened = await stream.openSegment({ chat, signal: signal() });
  expect(opened.kind).toBe('ready');
  if (opened.kind !== 'ready') throw new Error('expected ready segment');
  const page = await stream.loadPage({
    chat,
    signal: signal(),
    limit: 100,
    beforeOrdinal: null,
    expectedProjection: null,
  });
  if (page.kind !== 'ready') throw new Error('expected ready page');
  return {
    checkpoint: opened.value.checkpoint,
    entries: page.page.entries,
    contents: page.page.entries.map((entry) => (entry.message as UserMessage).content),
  };
}

function forkPointFor(
  checkpoint: Awaited<ReturnType<typeof openContents>>['checkpoint'],
  entryId: AgentTranscriptEntryId,
): AgentForkPoint {
  return {
    kind: 'projection-entry',
    agentOwnershipEpoch: chat.agentOwnershipEpoch,
    contentEpoch: checkpoint.projection.contentEpoch,
    entryId,
    durableRevision: checkpoint.projection.durableRevision,
  };
}

describe('existing-journal native audit', () => {
  it('coalesces concurrent segment opens onto one journal bind', async () => {
    const directory = await createDirectory();
    await openContents(streamOver(directory, () => [
      nativeMessage('item-1', 'first'),
      nativeMessage('item-2', 'second'),
    ]));

    let loads = 0;
    const stream = streamOver(directory, () => {
      loads += 1;
      return [
        nativeMessage('item-1', 'first'),
        nativeMessage('item-2', 'second'),
        nativeMessage('item-3', 'third'),
      ];
    });
    const [first, second, third] = await Promise.all([
      stream.openSegment({ chat, signal: signal() }),
      stream.openSegment({ chat, signal: signal() }),
      stream.openSegment({ chat, signal: signal() }),
    ]);
    expect(first.kind).toBe('ready');
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // One audit ran, and the suffix imported exactly once.
    expect(loads).toBe(1);
    const contents = await openContents(stream);
    expect(contents.contents).toEqual(['first', 'second', 'third']);
  });

  it('imports a crash-missed native suffix exactly once', async () => {
    const directory = await createDirectory();
    await openContents(streamOver(directory, () => [
      nativeMessage('item-1', 'first'),
      nativeMessage('item-2', 'second'),
    ]));

    const grown = () => [
      nativeMessage('item-1', 'first'),
      nativeMessage('item-2', 'second'),
      nativeMessage('item-3', 'third'),
    ];
    const reopened = await openContents(streamOver(directory, grown));
    expect(reopened.contents).toEqual(['first', 'second', 'third']);
    expect(reopened.checkpoint.projection.durableCount).toBe(3);

    const again = await openContents(streamOver(directory, grown));
    expect(again.contents).toEqual(['first', 'second', 'third']);
    expect(again.checkpoint.projection.durableRevision)
      .toBe(reopened.checkpoint.projection.durableRevision);
  });

  it('retains committed rows and advances the retention floor on native prefix loss', async () => {
    const directory = await createDirectory();
    await openContents(streamOver(directory, () => [
      nativeMessage('item-1', 'first'),
      nativeMessage('item-2', 'second'),
      nativeMessage('item-3', 'third'),
    ]));

    const pruned = streamOver(directory, () => [
      nativeMessage('item-2', 'second'),
      nativeMessage('item-3', 'third'),
    ]);
    const reopened = await openContents(pruned);
    expect(reopened.contents).toEqual(['first', 'second', 'third']);

    const belowFloor = await pruned.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(reopened.checkpoint, reopened.entries[0]!.id),
    });
    expect(belowFloor).toEqual({ kind: 'unavailable', reason: 'below-native-retention-floor' });
    const aboveFloor = await pruned.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(reopened.checkpoint, reopened.entries[2]!.id),
    });
    expect(aboveFloor.kind).toBe('ready');
  });

  it('records divergence for a native middle loss and never clears it silently', async () => {
    const directory = await createDirectory();
    await openContents(streamOver(directory, () => [
      nativeMessage('item-1', 'first'),
      nativeMessage('item-2', 'second'),
      nativeMessage('item-3', 'third'),
    ]));

    const diverged = streamOver(directory, () => [
      nativeMessage('item-1', 'first'),
      nativeMessage('item-3', 'third'),
    ]);
    const reopened = await openContents(diverged);
    expect(reopened.contents).toEqual(['first', 'second', 'third']);
    await expect(diverged.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(reopened.checkpoint, reopened.entries[2]!.id),
    })).resolves.toEqual({ kind: 'unavailable', reason: 'source-diverged' });

    const healthyAgain = streamOver(directory, () => [
      nativeMessage('item-1', 'first'),
      nativeMessage('item-2', 'second'),
      nativeMessage('item-3', 'third'),
    ]);
    const later = await openContents(healthyAgain);
    await expect(healthyAgain.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(later.checkpoint, later.entries[2]!.id),
    })).resolves.toEqual({ kind: 'unavailable', reason: 'source-diverged' });
  });

  it('records divergence when native reorders committed identities', async () => {
    const directory = await createDirectory();
    await openContents(streamOver(directory, () => [
      nativeMessage('item-1', 'first'),
      nativeMessage('item-2', 'second'),
    ]));

    const reordered = streamOver(directory, () => [
      nativeMessage('item-2', 'second'),
      nativeMessage('item-1', 'first'),
    ]);
    const reopened = await openContents(reordered);
    expect(reopened.contents).toEqual(['first', 'second']);
    await expect(reordered.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(reopened.checkpoint, reopened.entries[0]!.id),
    })).resolves.toEqual({ kind: 'unavailable', reason: 'source-diverged' });
  });

  it('fences fork continuity while the provider has not persisted the committed tail', async () => {
    const directory = await createDirectory();
    await openContents(streamOver(directory, () => [
      nativeMessage('item-1', 'first'),
      nativeMessage('item-2', 'second'),
      nativeMessage('item-3', 'third'),
    ]));

    const behindProvider = streamOver(directory, () => [nativeMessage('item-1', 'first')]);
    const reopened = await openContents(behindProvider);
    expect(reopened.contents).toEqual(['first', 'second', 'third']);
    await expect(behindProvider.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(reopened.checkpoint, reopened.entries[2]!.id),
    })).resolves.toEqual({ kind: 'unavailable', reason: 'projection-ahead-of-provider' });
    const settledPrefix = await behindProvider.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(reopened.checkpoint, reopened.entries[0]!.id),
    });
    expect(settledPrefix.kind).toBe('ready');

    // The fence clears once the provider persists the tail.
    const caughtUp = streamOver(directory, () => [
      nativeMessage('item-1', 'first'),
      nativeMessage('item-2', 'second'),
      nativeMessage('item-3', 'third'),
    ]);
    const later = await openContents(caughtUp);
    const resolved = await caughtUp.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(later.checkpoint, later.entries[2]!.id),
    });
    expect(resolved.kind).toBe('ready');
  });

  it('binds a live row for forking at the settled boundary without restart', async () => {
    const directory = await createDirectory();
    let persisted: ChatMessage[] = [];
    const stream = streamOver(directory, () => persisted);
    await openContents(stream);

    // A live commit lands in the journal before the provider persists it.
    await stream.appendMessages({
      chat,
      operation: null,
      messages: [new UserMessage('2026-06-01T00:00:00.000Z', 'streamed')],
      sources: [{
        source: { namespace: 'test:native', itemId: 'item-1', subrowId: 'row:0' },
        nativeAlias: null,
      }],
    });
    const before = await openContents(stream);
    await expect(stream.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(before.checkpoint, before.entries[0]!.id),
    })).resolves.toEqual({ kind: 'unavailable', reason: 'projection-ahead-of-provider' });

    // Provider persistence observed at the settled boundary binds the alias.
    persisted = [nativeMessage('item-1', 'streamed')];
    await stream.refreshNativeContinuity({ chat, signal: signal() });
    const after = await openContents(stream);
    expect(after.contents).toEqual(['streamed']);
    expect(after.checkpoint.projection.durableRevision)
      .toBe(before.checkpoint.projection.durableRevision);
    const resolved = await stream.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(after.checkpoint, after.entries[0]!.id),
    });
    expect(resolved.kind).toBe('ready');
  });

  it('serves the committed journal unchanged when evidence is unavailable or empty', async () => {
    const directory = await createDirectory();
    const first = await openContents(streamOver(directory, () => [
      nativeMessage('item-1', 'first'),
      nativeMessage('item-2', 'second'),
    ]));

    const unavailable = await openContents(streamOver(directory, () => {
      throw new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', 'evidence offline', true);
    }));
    expect(unavailable.contents).toEqual(['first', 'second']);

    const empty = streamOver(directory, () => []);
    const emptied = await openContents(empty);
    expect(emptied.contents).toEqual(['first', 'second']);
    // An empty read is ambiguous, so the floor must not advance.
    await expect(empty.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(emptied.checkpoint, emptied.entries[0]!.id),
    })).resolves.not.toEqual({ kind: 'unavailable', reason: 'below-native-retention-floor' });
    expect(emptied.checkpoint.projection.durableRevision)
      .toBe(first.checkpoint.projection.durableRevision);
  });
});
