import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage, type ChatMessage } from '@garcon/common/chat-types';
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

function admissionOperation() {
  const turnOwner = {
    agentOwnershipEpoch: chat.agentOwnershipEpoch,
    commandType: 'agent-run' as const,
    clientRequestId: 'held-request',
    turnId: 'held-turn',
  };
  return {
    agentOwnershipEpoch: chat.agentOwnershipEpoch,
    commandType: 'agent-run' as const,
    clientRequestId: 'held-request',
    clientMessageId: 'held-message',
    turnId: 'held-turn',
    turnOwner,
  };
}

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

  it('degrades resume continuity while ahead and restores it on catch-up', async () => {
    const directory = await createDirectory();
    await openContents(streamOver(directory, () => [
      nativeMessage('item-1', 'first'),
      nativeMessage('item-2', 'second'),
    ]));

    const behind = streamOver(directory, () => [nativeMessage('item-1', 'first')]);
    await openContents(behind);
    await expect(behind.resolveNativeSession({ chat, signal: signal() })).resolves.toMatchObject({
      kind: 'degraded',
      errorCode: 'PROJECTION_AHEAD_OF_PROVIDER',
      retryable: true,
    });

    const caughtUp = streamOver(directory, () => [
      nativeMessage('item-1', 'first'),
      nativeMessage('item-2', 'second'),
    ]);
    await openContents(caughtUp);
    await expect(caughtUp.resolveNativeSession({ chat, signal: signal() }))
      .resolves.toEqual({ kind: 'ready', value: null });
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
    await stream.settleNativeBoundary({ chat, signal: signal() });
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

  it('imports held provider output around the admission anchor at the settled boundary', async () => {
    const directory = await createDirectory();
    let persisted: ChatMessage[] = [];
    const stream = streamOver(directory, () => persisted);
    await openContents(stream);

    // Admission commits the user row; the provider never notifies any item.
    const operation = admissionOperation();
    const preparation = await stream.prepareInput({
      chat,
      signal: signal(),
      message: new UserMessage('2026-06-01T00:00:00.000Z', 'held prompt'),
      operation,
    });
    await preparation.commit();
    await stream.promoteActiveInput(chat, operation);

    // The rollout persisted both the user row and the held assistant answer.
    persisted = [
      nativeMessage('item-1', 'held prompt'),
      attachNativeMessageSource(
        new AssistantMessage('2026-06-01T00:00:01.000Z', 'held answer'),
        { entryId: 'item-2', lineNumber: 2, withinSourceOrdinal: 0 },
      ),
    ];
    await stream.settleNativeBoundary({ chat, operation, signal: signal() });

    const after = await openContents(stream);
    // The admission row is claimed rather than duplicated, and the held
    // answer imports once under the settling turn's provenance.
    expect(after.contents).toEqual(['held prompt', 'held answer']);
    expect(after.entries[1]!.provenance?.turnOwner.turnId).toBe(operation.turnOwner.turnId);
    const anchor = await stream.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(after.checkpoint, after.entries[0]!.id),
    });
    expect(anchor.kind).toBe('ready');

    // A repeated settled audit is a no-op.
    await stream.settleNativeBoundary({ chat, operation, signal: signal() });
    const again = await openContents(stream);
    expect(again.contents).toEqual(['held prompt', 'held answer']);
    expect(again.checkpoint.projection.durableRevision)
      .toBe(after.checkpoint.projection.durableRevision);
  });

  it('needs no fork-time repair after a settled boundary and reads no provider IO to resolve', async () => {
    const directory = await createDirectory();
    let persisted: ChatMessage[] = [];
    let evidenceReads = 0;
    const stream = new JournalBackedAgentTranscriptStream({
      ownerId: 'test',
      directory: async () => directory,
      bootstrap: async () => {
        evidenceReads += 1;
        return { kind: 'ready', value: transcriptSeedEntries('test', persisted) };
      },
    });
    await openContents(stream);
    await stream.appendMessages({
      chat,
      operation: null,
      messages: [new UserMessage('2026-06-01T00:00:00.000Z', 'streamed')],
      sources: [{
        source: { namespace: 'test:native', itemId: 'item-1', subrowId: 'row:0' },
        nativeAlias: null,
      }],
    });

    // Persistence became visible only after the first attempted read: the
    // proof-then-audit boundary still binds the alias and confirms together.
    persisted = [];
    await expect(stream.settleNativeBoundary({ chat, signal: signal() }))
      .resolves.toBe('unresolved');
    persisted = [nativeMessage('item-1', 'streamed')];
    await expect(stream.settleNativeBoundary({ chat, signal: signal() }))
      .resolves.toBe('confirmed');

    // Resolution succeeds from the bound journal alone: no repair, no
    // provider IO, no continuity mutation on the fork path.
    const readsBeforeResolution = evidenceReads;
    const after = await openContents(stream);
    const resolved = await stream.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(after.checkpoint, after.entries[0]!.id),
    });
    expect(resolved.kind).toBe('ready');
    expect(evidenceReads).toBe(readsBeforeResolution);

    // Persistence after the boundary stays fenced until the next boundary
    // rather than being repaired opportunistically by a fork attempt.
    await stream.appendMessages({
      chat,
      operation: null,
      messages: [new UserMessage('2026-06-01T00:00:01.000Z', 'second')],
      sources: [{
        source: { namespace: 'test:native', itemId: 'item-2', subrowId: 'row:0' },
        nativeAlias: null,
      }],
    });
    const pinned = await openContents(stream);
    persisted = [nativeMessage('item-1', 'streamed'), nativeMessage('item-2', 'second')];
    await expect(stream.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(pinned.checkpoint, pinned.entries[1]!.id),
    })).resolves.toEqual({ kind: 'unavailable', reason: 'projection-ahead-of-provider' });
    await stream.settleNativeBoundary({ chat, signal: signal() });
    await expect(stream.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(pinned.checkpoint, pinned.entries[1]!.id),
    })).resolves.toMatchObject({ kind: 'ready' });
  });

  it('suppresses imports and hole divergence around event-identified legacy rows', async () => {
    const directory = await createDirectory();
    let persisted: ChatMessage[] = [];
    const stream = streamOver(directory, () => persisted);
    await openContents(stream);
    // A grandfathered journal row persisted before adapters owed canonical
    // identity: native namespace under a process-local event identity.
    await stream.appendMessages({
      chat,
      operation: null,
      messages: [new AssistantMessage('2026-06-01T00:00:00.000Z', 'legacy assistant')],
      sources: [{
        source: { namespace: 'test:native', itemId: 'event:legacy-1', subrowId: 'row:0' },
        nativeAlias: null,
      }],
    });
    await stream.appendMessages({
      chat,
      operation: null,
      messages: [new UserMessage('2026-06-01T00:00:01.000Z', 'identified')],
      sources: [{
        source: { namespace: 'test:native', itemId: 'item-2', subrowId: 'row:0' },
        nativeAlias: null,
      }],
    });
    // Native holds an unmatchable assistant row plus trailing output; neither
    // may be imported or read as divergence while a legacy row exists.
    persisted = [
      nativeMessage('item-1', 'legacy assistant'),
      nativeMessage('item-2', 'identified'),
      nativeMessage('item-3', 'trailing'),
    ];
    await expect(stream.settleNativeBoundary({ chat, signal: signal() }))
      .resolves.toBe('confirmed');
    expect((await openContents(stream)).contents).toEqual(['legacy assistant', 'identified']);
  });

  it('suppresses imports while an identity-less surface row could shadow native output', async () => {
    const directory = await createDirectory();
    let persisted: ChatMessage[] = [];
    const stream = streamOver(directory, () => persisted);
    await openContents(stream);
    await stream.appendMessages({
      chat,
      operation: null,
      messages: [new UserMessage('2026-06-01T00:00:00.000Z', 'identified')],
      sources: [{
        source: { namespace: 'test:native', itemId: 'item-1', subrowId: 'row:0' },
        nativeAlias: null,
      }],
    });
    // A live-emitted provider banner without canonical identity lands in the
    // event namespace. Its native counterpart cannot be matched by identity,
    // so while it exists suffix imports are suppressed rather than risk
    // re-importing the same occurrence.
    await stream.appendMessages({
      chat,
      operation: null,
      messages: [new AssistantMessage('2026-06-01T00:00:01.000Z', 'surface banner')],
    });
    persisted = [
      nativeMessage('item-1', 'identified'),
      nativeMessage('item-2', 'held output'),
    ];
    await expect(stream.settleNativeBoundary({ chat, signal: signal() }))
      .resolves.toBe('confirmed');
    expect((await openContents(stream)).contents)
      .toEqual(['identified', 'surface banner']);
  });

  it('reads evidence from the relocated reference after updateNativeReference', async () => {
    const directory = await createDirectory();
    const evidenceByPath = new Map<string, ChatMessage[]>([
      ['old-path', []],
      ['new-path', [nativeMessage('item-1', 'streamed')]],
    ]);
    const stream = new JournalBackedAgentTranscriptStream({
      ownerId: 'test',
      directory: async () => directory,
      bootstrap: async (request) => {
        const path = (request.chat.nativeSession as { value?: { path?: string } } | null)?.value?.path
          ?? 'old-path';
        return { kind: 'ready', value: transcriptSeedEntries('test', evidenceByPath.get(path) ?? []) };
      },
    });
    const oldRef = { ...chat, nativeSession: { ownerId: 'test', schemaVersion: 1, value: { path: 'old-path' } } };
    await stream.openSegment({ chat: oldRef, signal: signal() });
    await stream.appendMessages({
      chat: oldRef,
      operation: null,
      messages: [new UserMessage('2026-06-01T00:00:00.000Z', 'streamed')],
      sources: [{
        source: { namespace: 'test:native', itemId: 'item-1', subrowId: 'row:0' },
        nativeAlias: null,
      }],
    });

    // The native session moved: settling against the stale reference cannot
    // prove persistence, but after the reference update it reads the new path.
    await expect(stream.settleNativeBoundary({ chat: oldRef, signal: signal() }))
      .resolves.toBe('unresolved');
    stream.updateNativeReference({
      ...chat,
      nativeSession: { ownerId: 'test', schemaVersion: 1, value: { path: 'new-path' } },
    });
    await expect(stream.settleNativeBoundary({ chat: oldRef, signal: signal() }))
      .resolves.toBe('confirmed');
  });

  it('settles the turn owner input on promotion but a steer only on native binding', async () => {
    const directory = await createDirectory();
    let persisted: ChatMessage[] = [];
    const stream = streamOver(directory, () => persisted);
    await openContents(stream);

    const owner = admissionOperation();
    const ownerPrep = await stream.prepareInput({
      chat,
      signal: signal(),
      message: new UserMessage('2026-06-01T00:00:00.000Z', 'owner prompt'),
      operation: owner,
    });
    await ownerPrep.commit();
    await stream.promoteActiveInput(chat, owner);

    // A mid-turn steer shares the turn owner but carries its own request id.
    const steerOwner = { ...owner.turnOwner };
    const steer = {
      agentOwnershipEpoch: owner.agentOwnershipEpoch,
      commandType: 'steer' as const,
      clientRequestId: 'steer-request',
      clientMessageId: 'steer-message',
      turnId: owner.turnId,
      turnOwner: steerOwner,
    };
    await stream.appendMessages({
      chat,
      operation: steer,
      messages: [new UserMessage('2026-06-01T00:00:01.000Z', 'steer text')],
      sources: [{
        source: { namespace: 'test:native', itemId: 'event:steer', subrowId: 'row:0' },
        nativeAlias: null,
      }],
    });

    // Routine settlement clears the turn owner immediately; the steer, not yet
    // native-bound, holds until proven persisted.
    const routine = await stream.settledInputRequests({ chat, signal: signal() });
    expect(routine).toEqual({ kind: 'ready', value: ['held-request'] });
    // The stop cohort holds even the owner to the persistence proof.
    const cohort = await stream.settledInputRequests({
      chat,
      signal: signal(),
      requireNativeBinding: true,
    });
    expect(cohort).toEqual({ kind: 'ready', value: [] });
  });

  it('settles a line-identified turn where native evidence orders the row after the user', async () => {
    const directory = await createDirectory();
    let persisted: ChatMessage[] = [];
    const stream = streamOver(directory, () => persisted);
    await openContents(stream);

    // A byte/line provider: admission commits the user row, and the finalized
    // assistant row carries only its line identity, emitted alone.
    const operation = admissionOperation();
    const preparation = await stream.prepareInput({
      chat,
      signal: signal(),
      message: new UserMessage('2026-06-01T00:00:00.000Z', 'prompt'),
      operation,
    });
    await preparation.commit();
    await stream.promoteActiveInput(chat, operation);
    await stream.appendMessages({
      chat,
      operation,
      messages: [attachNativeMessageSource(
        new AssistantMessage('2026-06-01T00:00:01.000Z', 'answer'),
        { lineNumber: 2 },
      )],
    });

    // The native file lists the user at line 1 and the assistant at line 2, so
    // the assistant is the second array row; its subrow must still be zero, or
    // the committed row and its evidence would never match.
    persisted = [
      attachNativeMessageSource(new UserMessage('2026-06-01T00:00:00.000Z', 'prompt'), { lineNumber: 1 }),
      attachNativeMessageSource(new AssistantMessage('2026-06-01T00:00:01.000Z', 'answer'), { lineNumber: 2 }),
    ];
    await expect(stream.settleNativeBoundary({ chat, operation, signal: signal() }))
      .resolves.toBe('confirmed');
    const after = await openContents(stream);
    expect(after.contents).toEqual(['prompt', 'answer']);
    const resolved = await stream.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(after.checkpoint, after.entries[1]!.id),
    });
    expect(resolved.kind).toBe('ready');
  });

  it('matches occurrence-identified rows through the settlement proof and persists the binding', async () => {
    const directory = await createDirectory();
    let persisted: ChatMessage[] = [];
    const stream = streamOver(directory, () => persisted);
    await openContents(stream);

    // Admission commits the user row; the provider notifies the assistant
    // occurrence under a durable integration occurrence identity whose native
    // entry ID is unknowable until the provider persists it.
    const operation = admissionOperation();
    const preparation = await stream.prepareInput({
      chat,
      signal: signal(),
      message: new UserMessage('2026-06-01T00:00:00.000Z', 'prompt'),
      operation,
    });
    await preparation.commit();
    await stream.promoteActiveInput(chat, operation);
    await stream.appendMessages({
      chat,
      operation,
      messages: [new AssistantMessage('2026-06-01T00:00:01.000Z', 'answer')],
      sources: [{
        source: { namespace: 'test:native', itemId: 'turn:t1:end:1', subrowId: 'row:0' },
        nativeAlias: null,
      }],
    });

    persisted = [
      nativeMessage('entry-1', 'prompt'),
      attachNativeMessageSource(
        new AssistantMessage('2026-06-01T00:00:01.000Z', 'answer'),
        { entryId: 'entry-2', lineNumber: 2, withinSourceOrdinal: 0 },
      ),
    ];
    await expect(stream.settleNativeBoundary({
      chat,
      operation,
      signal: signal(),
      sourceSettlement: async () => ({
        verdict: 'confirmed',
        itemAliases: new Map([['turn:t1:end:1', 'entry-2']]),
      }),
    })).resolves.toBe('confirmed');

    // The binding proves the occurrence: nothing imports twice and the fork
    // point resolves from the journal alone.
    const after = await openContents(stream);
    expect(after.contents).toEqual(['prompt', 'answer']);
    const resolved = await stream.resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(after.checkpoint, after.entries[1]!.id),
    });
    expect(resolved.kind).toBe('ready');

    // A restart audits through the persisted binding without the proof and
    // without duplicating or fencing the occurrence rows.
    const reopened = await openContents(streamOver(directory, () => persisted));
    expect(reopened.contents).toEqual(['prompt', 'answer']);
    const reresolved = await streamOver(directory, () => persisted).resolveNativeForkPoint({
      chat,
      signal: signal(),
      point: forkPointFor(reopened.checkpoint, reopened.entries[1]!.id),
    });
    expect(reresolved.kind).toBe('ready');
  });

  it('withholds success when a confirmed hook faces ambiguous native evidence', async () => {
    const directory = await createDirectory();
    let persisted: ChatMessage[] = [];
    const stream = streamOver(directory, () => persisted);
    await openContents(stream);
    // A provider-owed assistant occurrence is committed from a live event.
    await stream.appendMessages({
      chat,
      operation: null,
      messages: [new AssistantMessage('2026-06-01T00:00:01.000Z', 'answer')],
      sources: [{
        source: { namespace: 'test:native', itemId: 'turn:t1:end:0', subrowId: 'row:0' },
        nativeAlias: null,
      }],
    });

    // The native evidence is ambiguous: two rows share one native identity, so
    // the audit skips. A confirmed hook cannot override the owed row.
    persisted = [
      nativeMessage('dup-1', 'answer'),
      attachNativeMessageSource(
        new AssistantMessage('2026-06-01T00:00:02.000Z', 'answer'),
        { entryId: 'dup-1', lineNumber: 2, withinSourceOrdinal: 0 },
      ),
    ];
    await expect(stream.settleNativeBoundary({
      chat,
      signal: signal(),
      sourceSettlement: async () => ({ verdict: 'confirmed' }),
    })).resolves.toBe('unresolved');
  });

  it('withholds success when a confirmed hook faces a projection ahead of the provider', async () => {
    const directory = await createDirectory();
    let persisted: ChatMessage[] = [];
    const stream = streamOver(directory, () => persisted);
    await openContents(stream);
    await stream.appendMessages({
      chat,
      operation: null,
      messages: [new AssistantMessage('2026-06-01T00:00:01.000Z', 'answer')],
      sources: [{
        source: { namespace: 'test:native', itemId: 'item-1', subrowId: 'row:0' },
        nativeAlias: null,
      }],
    });

    // The provider has not persisted the committed occurrence yet, so the
    // projection is ahead. Even a confirmed hook cannot prove the suffix
    // durable, and the native file being empty skips the audit outright.
    persisted = [];
    await expect(stream.settleNativeBoundary({
      chat,
      signal: signal(),
      sourceSettlement: async () => ({ verdict: 'confirmed' }),
    })).resolves.toBe('unresolved');
    // Once the provider persists the occurrence, the confirmed hook and the
    // aligned audit agree.
    persisted = [nativeMessage('item-1', 'answer')];
    await expect(stream.settleNativeBoundary({
      chat,
      signal: signal(),
      sourceSettlement: async () => ({ verdict: 'confirmed' }),
    })).resolves.toBe('confirmed');
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
