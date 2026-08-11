import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AssistantMessage,
  BashToolUseMessage,
  CompactionMessage,
  parseChatMessage,
  PermissionRequestMessage,
  UserMessage,
} from '@garcon/common/chat-types';
import type {
  AgentOwnershipEpoch,
  AgentTranscriptAdmissionIdentity,
  AgentTranscriptEntry,
  AgentTranscriptProvenance,
  AgentTurnReceiptOwner,
} from '@garcon/server-agent-interface';
import { agentOwnershipEpoch } from '@garcon/server-agent-interface';
import { AgentInputAdmissionCoordinator } from '../admission.js';
import { applyProjectionEvent } from '../apply.js';
import { AgentProjectionJournal } from '../journal.js';
import {
  agentStreamOffset,
  newAgentStreamEpoch,
  newAgentTranscriptContentEpoch,
  newAgentTranscriptEntryId,
} from '../identity.js';
import { AgentProjectionPager } from '../paging.js';
import {
  AgentProjectionRevisionAccumulator,
  computeAgentStreamEventDigest,
} from '../revision.js';
import { createProjectionMaterialization } from '../state.js';
import { AgentProjectionEventStream } from '../stream.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('projection revisions', () => {
  it('remain stable across parser reconstruction and late optional fields', () => {
    const message = new CompactionMessage('2026-01-01T00:00:00.000Z', 'auto', 'summary');
    message.preTokens = 120;
    message.postTokens = 40;
    const reconstructed = parseChatMessage(JSON.parse(JSON.stringify(message)));
    expect(reconstructed).not.toBeNull();

    const originalEntry = entry(message);
    const first = new AgentProjectionRevisionAccumulator();
    first.add(originalEntry);
    const second = new AgentProjectionRevisionAccumulator();
    second.add({ ...originalEntry, message: reconstructed! });
    expect(first.finish()).toBe(second.finish());
    expect(first.finish()).toBe(first.finish());
  });
});

describe('AgentProjectionEventStream', () => {
  it('orders admission, promotion, controls, output, terminal, and offset commits', async () => {
    const fixture = projection();
    const events: string[] = [];
    fixture.stream.subscribe((event) => events.push(event.kind));
    const preparation = fixture.admission.prepare(
      new UserMessage(timestamp(), 'hello'),
      fixture.operation,
    );
    const accepted = await preparation.commit();
    const active = accepted.appended[0]!;
    expect(fixture.stream.current.entries).toHaveLength(1);

    await fixture.stream.commit(
      [{ entryId: active.id, source: source('user') }],
      [entry(new AssistantMessage(timestamp(), 'answer'), fixture.provenance, source('assistant'))],
    );
    await fixture.stream.control(fixture.operation, {
      kind: 'upsert',
      row: {
        id: 'permission',
        incarnation: 'one',
        operation: fixture.operation,
        anchorEntryId: active.id,
        displayOrder: 0,
        message: permissionRequest('permission'),
      },
    });
    const terminal = await fixture.stream.terminal({
      operation: fixture.operation,
      outcome: { kind: 'finished', exitCode: 0 },
      completeness: {
        acceptedInputEntryIds: [active.id],
        attributableEntryCount: 2,
      },
      sourceSettlement: 'confirmed',
    });

    expect(events).toEqual(['commit', 'commit', 'control', 'terminal']);
    expect(fixture.stream.replay(accepted.previous)).toMatchObject({ kind: 'events' });
    fixture.stream.commitOffset({
      chatId: fixture.identity.chatId,
      agentOwnershipEpoch: fixture.identity.agentOwnershipEpoch,
      applied: terminal.checkpoint,
    });
    expect(fixture.stream.replay(terminal.checkpoint)).toEqual({
      kind: 'events',
      events: [],
      checkpoint: terminal.checkpoint,
    });
  });

  it('rotates the stream epoch when discarding an active input and preserves controls', async () => {
    const fixture = projection();
    const preparation = fixture.admission.prepare(
      new UserMessage(timestamp(), 'steer'),
      fixture.operation,
    );
    await preparation.commit();
    await fixture.stream.control(fixture.operation, {
      kind: 'upsert',
      row: {
        id: 'permission',
        incarnation: 'one',
        operation: fixture.operation,
        anchorEntryId: null,
        displayOrder: 0,
        message: permissionRequest('permission'),
      },
    });
    const oldEpoch = fixture.stream.current.checkpoint.projection.epoch;
    const reset = await preparation.discardCommitted();
    expect(reset.checkpoint.projection.epoch).not.toBe(oldEpoch);
    expect(reset.checkpoint.projection.contentEpoch).toBe(reset.previous.projection.contentEpoch);
    expect(fixture.stream.current.entries).toEqual([]);
    expect([...fixture.stream.current.controls]).toHaveLength(1);
  });

  it('rejects a same-address event whose active payload differs', async () => {
    const fixture = projection();
    const accepted = await fixture.admission.prepare(
      new UserMessage(timestamp(), 'one'),
      fixture.operation,
    ).commit();
    const corrupt = {
      ...accepted,
      appended: [{ ...accepted.appended[0]!, message: new UserMessage(timestamp(), 'two') }],
    };
    const relation = fixture.stream.classify({
      event: { ...corrupt, digest: computeAgentStreamEventDigest(corrupt) },
      applied: accepted.checkpoint,
      committed: accepted.previous,
      proofs: new Map([[`${accepted.checkpoint.projection.epoch}:${accepted.checkpoint.offset}`, {
        digest: accepted.digest,
        checkpoint: accepted.checkpoint,
      }]]),
    });
    expect(relation.kind).toBe('corrupt');
  });
});

describe('AgentProjectionPager', () => {
  it('keeps a page chain pinned while transient events advance the stream', async () => {
    const fixture = projection([
      entry(new UserMessage(timestamp(), 'one'), fixtureProvenance(), source('one')),
      entry(new AssistantMessage(timestamp(), 'two'), fixtureProvenance(), source('two')),
    ]);
    const pager = new AgentProjectionPager();
    const projectionState = fixture.stream.current.checkpoint.projection;
    const first = pager.page({
      current: projectionState,
      entries: fixture.stream.current.entries,
      expected: null,
      beforeOrdinal: null,
      limit: 1,
    });
    await fixture.stream.control(fixture.operation, { kind: 'clear' });
    const second = pager.page({
      current: fixture.stream.current.checkpoint.projection,
      entries: fixture.stream.current.entries,
      expected: projectionState,
      beforeOrdinal: first.kind === 'ready' ? first.page.firstOrdinal : null,
      limit: 1,
    });
    expect(second).toMatchObject({ kind: 'ready', page: { firstOrdinal: 1 } });
  });
});

describe('AgentProjectionJournal', () => {
  it('recovers durable envelopes and discarded admission identities without active state', async () => {
    const directory = await tempDirectory();
    const fixture = projection();
    const journal = await AgentProjectionJournal.open({ directory, ...fixture.identity });
    const stream = new AgentProjectionEventStream({
      initial: fixture.stream.current,
      persist: (event, previous, resulting) => journal.persist(event, previous, resulting),
    });
    const admission = new AgentInputAdmissionCoordinator(stream);
    const preparation = admission.prepare(new UserMessage(timestamp(), 'hello'), fixture.operation);
    const accepted = await preparation.commit();
    await stream.commit(
      [{ entryId: accepted.appended[0]!.id, source: source('user') }],
      [entry(new AssistantMessage(timestamp(), 'answer'), fixture.provenance, source('assistant'))],
    );
    const reloaded = await AgentProjectionJournal.open({ directory, ...fixture.identity });
    expect(reloaded.state.entries.map((value) => value.id)).toEqual(
      stream.current.entries.map((value) => value.id),
    );

    const next = projection([], fixture.identity);
    const discardJournal = await AgentProjectionJournal.open({
      directory: await tempDirectory(),
      ...next.identity,
    });
    const discardStream = new AgentProjectionEventStream({
      initial: next.stream.current,
      persist: (event, previous, resulting) => discardJournal.persist(event, previous, resulting),
    });
    const discardAdmission = new AgentInputAdmissionCoordinator(discardStream);
    const rejected = discardAdmission.prepare(new UserMessage(timestamp(), 'reject'), next.operation);
    const committed = await rejected.commit();
    await rejected.discardCommitted();
    const reopened = await AgentProjectionJournal.open({
      directory: path.dirname(discardJournal.filePath),
      ...next.identity,
    });
    expect(reopened.resolveDiscardedAdmission(next.operation)).toEqual({
      entryId: committed.appended[0]!.id,
    });
  });

  it('truncates an incomplete trailing record and rejects malformed complete records', async () => {
    const directory = await tempDirectory();
    const identity = projection().identity;
    const journal = await AgentProjectionJournal.open({ directory, ...identity });
    await fs.appendFile(journal.filePath, '{"kind":"append"');
    await expect(AgentProjectionJournal.open({ directory, ...identity })).resolves.toBeInstanceOf(
      AgentProjectionJournal,
    );
    await fs.appendFile(journal.filePath, 'not-json\n');
    await expect(AgentProjectionJournal.open({ directory, ...identity })).rejects.toThrow(
      'malformed record',
    );
  });
});

function projection(
  entries: readonly AgentTranscriptEntry[] = [],
  suppliedIdentity?: { readonly chatId: string; readonly agentOwnershipEpoch: AgentOwnershipEpoch },
) {
  const identity = suppliedIdentity ?? {
    chatId: crypto.randomUUID(),
    agentOwnershipEpoch: agentOwnershipEpoch(crypto.randomUUID()),
  };
  const operation = operationIdentity(identity.agentOwnershipEpoch);
  const initial = createProjectionMaterialization({
    ...identity,
    epoch: newAgentStreamEpoch(),
    contentEpoch: newAgentTranscriptContentEpoch(),
    entries,
  });
  const stream = new AgentProjectionEventStream({ initial });
  return {
    identity,
    operation,
    provenance: { ...operation, upstreamRequestId: null } satisfies AgentTranscriptProvenance,
    stream,
    admission: new AgentInputAdmissionCoordinator(stream),
  };
}

function fixtureProvenance(): AgentTranscriptProvenance {
  return { ...operationIdentity(agentOwnershipEpoch('epoch')), upstreamRequestId: null };
}

function operationIdentity(epoch: AgentOwnershipEpoch): AgentTranscriptAdmissionIdentity {
  const turnOwner: AgentTurnReceiptOwner = {
    agentOwnershipEpoch: epoch,
    commandType: 'agent-run',
    clientRequestId: 'owner-request',
    turnId: 'turn',
  };
  return {
    agentOwnershipEpoch: epoch,
    commandType: 'agent-run',
    clientRequestId: 'owner-request',
    clientMessageId: 'message',
    turnId: 'turn',
    turnOwner,
  };
}

function entry(
  message: AgentTranscriptEntry['message'],
  provenance: AgentTranscriptProvenance | null = null,
  sourceIdentity = source(crypto.randomUUID()),
): AgentTranscriptEntry & { readonly lifetime: 'durable' } {
  return {
    id: newAgentTranscriptEntryId(),
    lifetime: 'durable',
    source: sourceIdentity,
    provenance,
    message,
  };
}

function source(itemId: string) {
  return { namespace: 'test', itemId, subrowId: 'message' };
}

function permissionRequest(id: string): PermissionRequestMessage {
  return new PermissionRequestMessage(
    timestamp(),
    id,
    new BashToolUseMessage(timestamp(), `tool-${id}`, 'true'),
  );
}

function timestamp(): string {
  return '2026-01-01T00:00:00.000Z';
}

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-projection-'));
  temporaryDirectories.push(directory);
  return directory;
}
