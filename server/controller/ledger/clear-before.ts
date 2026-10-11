import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import { isPreambleApplicationNoticeDetail } from '../../../common/transcript-notice-details.js';
import { DomainError } from '../../common/domain-error.js';
import { projectLedgerAgentCommandOutcome, projectLedgerTicketCommandOutcome, transcriptViewId,
  type LedgerRowDraft, type TranscriptView, type TranscriptWatermark } from './contracts.js';
import { PreambleHistoryCollector, retainedPreambleHistoryMetadata } from './preamble-history.js';
import type { TranscriptLedgerService } from './service.js';

export async function stageBeforeMessage(
  ledger: TranscriptLedgerService,
  chatId: string,
  current: TranscriptView,
  watermark: TranscriptWatermark,
  ordinal: number,
  signal: AbortSignal,
  flushBoundary: () => Promise<void>,
): Promise<TranscriptView> {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > watermark.ordinal) throw invalidTarget();
  const edge = ledger.page(chatId, current.viewId, 2, ordinal + 1).rows;
  const selected = edge.at(-1);
  if (selected?.ordinal !== ordinal || selected.kind !== 'user-input') throw invalidTarget();
  const previous = edge.at(-2);
  const firstOrdinal = previous?.kind === 'notice' && isPreambleApplicationNoticeDetail(previous.detail)
    ? previous.ordinal : ordinal;
  const session = ledger.currentSession(chatId);
  const collector = new PreambleHistoryCollector();
  const drafts: LedgerRowDraft[] = [];
  const steps = new EventLoopSteps('ledger-clear-before');
  const fromOrdinal = session ? Math.min(firstOrdinal, current.contentStartOrdinal) : firstOrdinal;
  for await (const page of ledger.rowPagesThrough(chatId, watermark, fromOrdinal, signal)) {
    for (const row of page) {
      if (session && row.ordinal >= current.contentStartOrdinal) collector.add([row]);
      if (row.ordinal >= firstOrdinal) {
        const { viewId: _viewId, ordinal: _ordinal, ...draft } = row;
        drafts.push(draft);
      }
      await steps.next();
    }
  }
  await flushBoundary();
  const removedEvidence = collector.finishBefore(firstOrdinal);
  const contentStartOrdinal = Math.max(0, current.contentStartOrdinal - firstOrdinal) + 1;
  const supportIndex = contentStartOrdinal - 1;
  const needsSupport = session !== null && (session.ordinal < firstOrdinal || removedEvidence.length > 0);
  if (needsSupport) {
    drafts.splice(supportIndex, 0, {
      kind: 'session', at: session.at, detail: session.detail,
      providerMeta: retainedPreambleHistoryMetadata(removedEvidence),
    });
  }
  const viewId = transcriptViewId(crypto.randomUUID());
  // Only typed controller correlations move; authored text and deleted sources stay untouched.
  for (const [draftIndex, draft] of drafts.entries()) {
    const correlation = draft.kind === 'notice'
      ? projectLedgerAgentCommandOutcome(draft.detail) ?? projectLedgerTicketCommandOutcome(draft.detail) : null;
    if (draft.kind === 'notice' && correlation?.requestViewId === current.viewId
      && correlation.requestOrdinal >= firstOrdinal && correlation.requestOrdinal <= watermark.ordinal) {
      const index = correlation.requestOrdinal - firstOrdinal;
      drafts[draftIndex] = { ...draft, detail: { ...draft.detail, requestViewId: viewId,
        requestOrdinal: index + 1 + (needsSupport && index >= supportIndex ? 1 : 0) } };
    }
    await steps.next();
  }
  signal.throwIfAborted();
  return ledger.stageView(chatId, drafts, contentStartOrdinal, viewId);
}

function invalidTarget(): DomainError {
  return new DomainError('VALIDATION_FAILED', 'Clear before message requires a user message in the confirmed transcript.', 422, false);
}
