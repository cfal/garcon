import { afterEach, describe, expect, it } from 'bun:test';
import { AssistantMessage } from '../../../common/chat-types.js';
import { agentOwnershipEpoch } from '@garcon/server-agent-interface';
import {
  agentStreamEpoch,
  agentTranscriptContentEpoch,
  agentTranscriptEntryId,
} from '@garcon/server-agent-common/transcript-projection/identity';
import { AgentProjectionPager } from '@garcon/server-agent-common/transcript-projection/paging';
import { createProjectionMaterialization } from '@garcon/server-agent-common/transcript-projection/state';
import { AgentProjectionEventStream } from '@garcon/server-agent-common/transcript-projection/stream';
import { AgentProjectionIngress } from '../projection-ingress.js';

const openedIngresses = new Set();

afterEach(() => {
  for (const ingress of openedIngresses) ingress.close();
  openedIngresses.clear();
});

describe('AgentProjectionIngress', () => {
  it('closes the subscribe-before-open race without applying the opened prefix twice', async () => {
    const fixture = projectionFixture();
    const applied = [];
    fixture.transcript.beforeOpen = async () => {
      await fixture.transcript.append(entry(fixture, 'during-open'));
    };
    fixture.ingress.onApply(async ({ event }) => applied.push(event));

    const opened = await fixture.ingress.open(
      fixture.integration,
      fixture.chat,
      AbortSignal.timeout(1_000),
    );

    expect(opened.kind).toBe('ready');
    expect(opened.value.entries.map((value) => value.message.content)).toEqual(['during-open']);
    expect(applied).toEqual([]);
  });

  it('replays a skipped event before applying a later callback', async () => {
    const fixture = projectionFixture();
    const applied = [];
    fixture.ingress.onApply(async ({ event }) => applied.push(event));
    await fixture.open();
    fixture.transcript.deliveryEnabled = false;
    await fixture.transcript.append(entry(fixture, 'first'));
    fixture.transcript.deliveryEnabled = true;
    await fixture.transcript.append(entry(fixture, 'second'));

    await waitFor(() => applied.length === 2);

    expect(applied.map((event) => event.appended[0].message.content)).toEqual(['first', 'second']);
    expect(fixture.ingress.current(fixture.chat).entries).toHaveLength(2);
  });

  it('retries a failed consumer-offset commit without reapplying a duplicate event', async () => {
    const fixture = projectionFixture();
    const applied = [];
    fixture.ingress.onApply(async ({ event }) => applied.push(event));
    await fixture.open();
    fixture.transcript.offsetCommitFailures = 2;
    const event = await fixture.transcript.append(entry(fixture, 'once'));
    fixture.transcript.redeliver(event);

    await waitFor(() => (
      fixture.transcript.source.committed.offset === event.checkpoint.offset
    ));

    expect(applied).toHaveLength(1);
    expect(fixture.transcript.offsetCommitAttempts).toBeGreaterThanOrEqual(3);
  });

  it('ignores a delayed event from the superseded epoch after reset', async () => {
    const fixture = projectionFixture();
    const applied = [];
    fixture.ingress.onApply(async ({ event }) => applied.push(event));
    await fixture.open();
    const old = await fixture.transcript.append(entry(fixture, 'old'));
    await waitFor(() => applied.length === 1);
    await fixture.transcript.reset([]);
    await waitFor(() => applied.length === 2);
    fixture.transcript.redeliver(old);
    await delay(20);

    expect(applied).toHaveLength(2);
    expect(fixture.ingress.current(fixture.chat).entries).toEqual([]);
  });

  it('fails a terminal whose producer completeness does not match the applied frontier', async () => {
    const fixture = projectionFixture();
    const failures = [];
    const applied = [];
    fixture.ingress.onApply(async ({ event }) => applied.push(event));
    fixture.ingress.onFailure(async (failure) => failures.push(failure));
    await fixture.open();
    const owner = turnOwner(fixture.chat.agentOwnershipEpoch);
    await fixture.transcript.append(entry(fixture, 'answer', owner));
    await waitFor(() => applied.length === 1);

    await fixture.transcript.source.terminal({
      operation: operation(owner),
      outcome: { kind: 'finished', exitCode: 0 },
      completeness: { acceptedInputEntryIds: [], attributableEntryCount: 2 },
      sourceSettlement: 'confirmed',
    });
    await waitFor(() => failures.length === 1);

    expect(failures[0].error.message).toContain('attributable entry count');
    expect(applied).toHaveLength(1);
  });
});

function projectionFixture() {
  const ownership = agentOwnershipEpoch('ownership-1');
  const chat = {
    chatId: 'chat-1',
    agentId: 'test',
    agentSessionId: null,
    projectPath: '/tmp/project',
    model: 'test',
    nativeSession: null,
    carryOverRevision: 'carry',
    nativeSeedReceipt: null,
    settings: { schemaVersion: 1, value: {} },
    agentOwnershipEpoch: ownership,
  };
  const initial = createProjectionMaterialization({
    chatId: chat.chatId,
    agentOwnershipEpoch: ownership,
    epoch: agentStreamEpoch('stream-1'),
    contentEpoch: agentTranscriptContentEpoch('content-1'),
  });
  const transcript = new TestTranscript(initial);
  const integration = { transcript };
  const ingress = new AgentProjectionIngress([integration]);
  openedIngresses.add(ingress);
  return {
    chat,
    integration,
    transcript,
    ingress,
    open: async () => {
      const result = await ingress.open(integration, chat, AbortSignal.timeout(1_000));
      expect(result.kind).toBe('ready');
      return result;
    },
  };
}

class TestTranscript {
  listeners = new Set();
  pager = new AgentProjectionPager();
  deliveryEnabled = true;
  beforeOpen = null;
  offsetCommitFailures = 0;
  offsetCommitAttempts = 0;

  constructor(initial) {
    this.source = new AgentProjectionEventStream({ initial });
    this.pager.retain(initial.checkpoint.projection, initial.entries);
    this.source.subscribe((event) => {
      this.pager.retain(this.source.current.checkpoint.projection, this.source.current.entries);
      if (this.deliveryEnabled) this.redeliver(event);
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  redeliver(event) {
    for (const listener of this.listeners) listener(event);
  }

  async openSegment() {
    await this.beforeOpen?.();
    return { kind: 'ready', value: { checkpoint: this.source.current.checkpoint, idle: true } };
  }

  async replay({ after }) {
    return this.source.replay(after);
  }

  async loadPage({ limit, beforeOrdinal, expectedProjection }) {
    return this.pager.page({
      current: this.source.current.checkpoint.projection,
      entries: this.source.current.entries,
      expected: expectedProjection,
      beforeOrdinal,
      limit,
    });
  }

  async commitOffset({ commit }) {
    this.offsetCommitAttempts += 1;
    if (this.offsetCommitFailures > 0) {
      this.offsetCommitFailures -= 1;
      throw new Error('injected offset failure');
    }
    this.source.commitOffset(commit);
  }

  append(value) {
    return this.source.commit([], [value]);
  }

  reset(entries) {
    return this.source.reset({
      reason: 'journal-repair',
      epoch: agentStreamEpoch('stream-2'),
      contentEpoch: agentTranscriptContentEpoch('content-2'),
      entries,
    });
  }
}

function entry(fixture, content, owner = null) {
  const id = agentTranscriptEntryId(`entry-${content}`);
  return {
    id,
    lifetime: 'durable',
    source: { namespace: 'test', itemId: id, subrowId: 'message' },
    provenance: owner ? {
      ...operation(owner),
      upstreamRequestId: null,
    } : null,
    message: new AssistantMessage('2026-08-11T00:00:00.000Z', content),
  };
}

function turnOwner(agentOwnershipEpoch) {
  return {
    agentOwnershipEpoch,
    commandType: 'agent-run',
    clientRequestId: 'request-1',
    turnId: 'turn-1',
  };
}

function operation(owner) {
  return {
    ...owner,
    clientMessageId: null,
    turnOwner: owner,
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for projection state');
    await delay(5);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
