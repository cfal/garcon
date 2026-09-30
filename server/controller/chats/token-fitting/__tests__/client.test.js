import { afterEach, describe, expect, it } from 'bun:test';
import {
  AssistantMessage,
  BashToolUseMessage,
  ToolResultMessage,
  UserMessage,
} from '../../../../../common/chat-types.ts';
import { decodeStoredLedgerRow } from '../../../ledger/codec.ts';
import { storedProviderRows } from '../../../ledger/__tests__/stored-rows.ts';
import { foldRowsForExport } from '../../../ledger/export-fold.ts';
import { foldHandoffArtifactEntries } from '../../handoff-artifact/projection.ts';
import { renderFittedHandoffArtifact } from '../../handoff-artifact/xml.ts';
import { assessCarryover, fitCompactionPrompt } from '../carryover.ts';
import { TokenFittingWorker } from '../client.ts';

const AT = '2026-01-01T00:00:00.000Z';
const DESTINATION = { agentId: 'claude', model: 'opus', prompt: 'keep going' };
const CHAT = { id: 'chat-1', title: 'Fitting fixture', agentId: 'codex', model: 'gpt-test' };
// A main-thread run of this transcript's assessment stalls the event loop for
// hundreds of milliseconds; the Worker path must stay well below that.
const LONG_TURNS = 600;
const LONG_WORDS = 400;
const MAX_EVENT_LOOP_GAP_MS = 200;

let fitting = null;

afterEach(() => {
  fitting?.close();
  fitting = null;
});

describe('TokenFittingWorker', () => {
  it('matches in-process fitting across batched transfers', async () => {
    fitting = new TokenFittingWorker();
    const messages = transcript(150, 120);
    const prompt = {
      messages,
      destination: DESTINATION,
      contextWindowTokens: 32_768,
      maximumEntryBudgetTokens: null,
    };
    const artifact = {
      chat: CHAT,
      transcriptViewId: 'view-1',
      lastOrdinal: messages.length,
      contextWindowTokens: 32_768,
      rows: storedProviderRows(messages),
    };

    expect(await fitting.assessCarryover(messages)).toEqual(assessCarryover(messages));
    const fitted = await fitting.fitCompactionPrompt(prompt);
    expect(fitted.kind).toBe('fitted');
    expect(fitted).toEqual(fitCompactionPrompt(prompt));
    const rendered = await fitting.renderHandoffArtifact(artifact);
    expect(rendered?.budgetOmittedEntryCount).toBeGreaterThan(0);
    expect(rendered).toEqual(renderFittedHandoffArtifact({
      chat: artifact.chat,
      transcriptViewId: artifact.transcriptViewId,
      lastOrdinal: artifact.lastOrdinal,
      contextWindowTokens: artifact.contextWindowTokens,
      sourceFold: foldHandoffArtifactEntries(foldRowsForExport(artifact.rows.map(decodeStoredLedgerRow))),
    }));
  });

  it('keeps the event loop responsive while fitting a long transcript', async () => {
    fitting = new TokenFittingWorker();
    const messages = transcript(LONG_TURNS, LONG_WORDS);
    let assessment;
    let fitted;

    const gap = await maxEventLoopGap(async () => {
      assessment = await fitting.assessCarryover(messages);
      fitted = await fitting.fitCompactionPrompt({
        messages,
        destination: DESTINATION,
        contextWindowTokens: 200_000,
        maximumEntryBudgetTokens: null,
      });
    });

    expect(assessment).toEqual({ kind: 'needs-compaction' });
    expect(fitted.kind).toBe('fitted');
    expect(gap).toBeLessThan(MAX_EVENT_LOOP_GAP_MS);
  });

  it('bounds each transfer by the text it carries, not only by message count', async () => {
    fitting = new TokenFittingWorker();
    // One batch of these would clone 256 MB in a single main-thread step.
    const messages = Array.from({ length: 256 }, (_, index) => new AssistantMessage(AT, `${index} ${'x'.repeat(1_000_000)}`));

    const gap = await maxEventLoopGap(async () => {
      expect(await fitting.assessCarryover(messages)).toMatchObject({ kind: expect.any(String) });
    });

    expect(gap).toBeLessThan(MAX_EVENT_LOOP_GAP_MS);
  }, 60_000);

  it('abandons an aborted running task and serves the next task from a fresh Worker', async () => {
    fitting = new TokenFittingWorker();
    const controller = new AbortController();
    const running = fitting.assessCarryover(transcript(LONG_TURNS, LONG_WORDS), controller.signal);
    const next = fitting.assessCarryover(transcript(2, 5));
    setTimeout(() => controller.abort(new Error('handoff stopped')), 50);

    await expect(running).rejects.toThrow('handoff stopped');
    expect(await next).toMatchObject({ kind: 'complete' });
  });

  it('drops a queued task aborted before it starts', async () => {
    fitting = new TokenFittingWorker();
    const running = fitting.assessCarryover(transcript(LONG_TURNS, LONG_WORDS));
    const controller = new AbortController();
    const queued = fitting.assessCarryover(transcript(2, 5), controller.signal);
    controller.abort(new Error('no longer needed'));

    await expect(queued).rejects.toThrow('no longer needed');
    expect(await running).toEqual({ kind: 'needs-compaction' });
  });

  it('reports task failures and recovers after losing the Worker', async () => {
    fitting = new TokenFittingWorker();

    await expect(fitting.assessCarryover([{ type: 'not-a-message' }]))
      .rejects.toThrow('Token fitting received an invalid chat message');
    await expect(fitting.assessCarryover([{ type: 'user-message', content: () => 'x' }]))
      .rejects.toThrow();
    expect(await fitting.assessCarryover(transcript(2, 5))).toMatchObject({ kind: 'complete' });
  });

  it('reports the code of a stored row that fails to decode', async () => {
    fitting = new TokenFittingWorker();
    const [row] = storedProviderRows(transcript(1, 5));

    await expect(fitting.renderHandoffArtifact({
      chat: CHAT,
      transcriptViewId: 'view-1',
      lastOrdinal: 1,
      contextWindowTokens: 32_768,
      rows: [{ ...row, payload_json: 'not json' }],
    })).rejects.toMatchObject({ message: 'Stored transcript row is invalid', code: 'UNDECODABLE_LEDGER_ROW' });
  });

  it('rejects running, queued, and later tasks once closed', async () => {
    fitting = new TokenFittingWorker();
    const running = fitting.assessCarryover(transcript(LONG_TURNS, LONG_WORDS));
    const queued = fitting.assessCarryover(transcript(2, 5));
    fitting.close();

    await expect(running).rejects.toThrow('Token fitting is closed');
    await expect(queued).rejects.toThrow('Token fitting is closed');
    await expect(fitting.assessCarryover([])).rejects.toThrow('Token fitting is closed');
  });
});

function transcript(turns, words) {
  const messages = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const body = Array.from({ length: words }, (_, index) => `word_${turn}_${index}`).join(' ');
    messages.push(new UserMessage(AT, `Request ${turn}: ${body}`));
    messages.push(new BashToolUseMessage(AT, `tool-${turn}`, `run --step ${turn}`));
    messages.push(new ToolResultMessage(AT, `tool-${turn}`, { output: body }, false));
    messages.push(new AssistantMessage(AT, `Result ${turn}: ${body}`));
  }
  return messages;
}

async function maxEventLoopGap(work) {
  let last = performance.now();
  let max = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 5);
  try {
    await work();
  } finally {
    clearInterval(probe);
  }
  return Math.max(max, performance.now() - last);
}
