import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TranscriptLedgerStore } from '../../ledger/store.ts';
import { TranscriptLedgerService } from '../../ledger/service.ts';
import { frozenConversationDrafts } from '../../ledger/projection.ts';
import { DomainError } from '../../lib/domain-error.ts';
import { AgentStartProgress } from '../agent-start-progress.ts';
import { ledgerRowToMessage } from '../../ledger/presentation.ts';

describe('delegated startup milestones', () => {
  let directory;
  let store;
  let ledger;
  let abort;
  let progress;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'agent-start-progress-'));
    store = new TranscriptLedgerStore(directory);
    ledger = new TranscriptLedgerService(store);
    ledger.initializeChat('child');
    abort = new AbortController();
    progress = new AgentStartProgress(ledger, 'child', 'startup-turn', abort.signal);
  });
  afterEach(async () => {
    progress.dispose();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('appends persistent phase history without affecting context or the frozen seed', () => {
    const phases = ['preparing-context', 'compacting-context', 'starting-agent', 'started'];
    for (const phase of phases) progress.report(phase);
    progress.report('started');
    abort.abort();
    expect(ledger.currentRows('child').map((row) => row.detail.phase)).toEqual(phases);
    expect(ledger.currentRows('child').map((row) => ledgerRowToMessage(row).detail.phase)).toEqual(phases);
    expect(ledger.conversationMessages('child')).toEqual([]);
    expect(frozenConversationDrafts(ledger.currentRows('child'))).toEqual([]);
    store.close();
    store = new TranscriptLedgerStore(directory);
    ledger = new TranscriptLedgerService(store);
    expect(ledger.currentRows('child').map((row) => row.detail.phase)).toEqual(phases);
    expect(ledger.activeChatIds()).toEqual([]);
  });

  it('records interruption once and rejects late phases', () => {
    progress.report('preparing-context');
    abort.abort();
    progress.report('starting-agent');
    progress.fail(new Error('late failure'));
    expect(ledger.currentRows('child').map((row) => row.detail.phase))
      .toEqual(['preparing-context', 'interrupted']);
  });

  it('retains an actionable domain failure without leaking unknown exception details', () => {
    progress.fail(new DomainError('CARRYOVER_COMPACTION_FAILED', 'Choose another compaction model.', 422));
    expect(ledger.currentRows('child')[0].message).toContain('Choose another compaction model.');
    ledger.initializeChat('other');
    const other = new AgentStartProgress(ledger, 'other', 'other-turn', abort.signal);
    other.fail(new Error('private implementation data'));
    other.dispose();
    expect(ledger.currentRows('other')[0].message).not.toContain('private implementation data');
  });

  it('does not recreate a deleted chat or publish into its replacement view', () => {
    ledger.deleteChat('child');
    ledger.initializeChat('child');
    progress.report('starting-agent');
    abort.abort();
    expect(ledger.currentRows('child')).toEqual([]);
  });

  it('does not let a failed outcome write replace the startup error', () => {
    ledger.appendNotice = () => { throw new Error('Synthetic persistence failure'); };
    expect(() => progress.fail(new DomainError('CARRYOVER_COMPACTION_FAILED', 'Synthetic startup failure', 502)))
      .not.toThrow();
    expect(() => abort.abort()).not.toThrow();
    expect(ledger.currentRows('child')).toEqual([]);
  });
});
