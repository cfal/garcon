import { UserMessage, type ChatMessage } from '../../../common/chat-types.js';
import {
  PREAMBLE_OPEN_PREFIX,
  preamblePrefixSha256,
  parsePreamblePrefixReceipt,
  type PreamblePrefixReceipt,
} from '../../../common/preamble-prefix.js';
import {
  isPreambleApplicationNoticeDetail,
  type AppliedPreambleReference,
} from '../../../common/transcript-notice-details.js';
import { normalizePendingPreambleBoundary, type PendingPreambleBoundary } from '../../../common/preambles.js';
import { isRecord, type JsonObject } from '../../../common/json.js';
import type { LedgerRow } from './contracts.js';

export interface PreambleHistoryEvidence {
  readonly receipt: PreamblePrefixReceipt;
  readonly boundary: PendingPreambleBoundary;
  readonly preambles: readonly AppliedPreambleReference[];
  readonly requiresNativeOccurrence: boolean;
}

export interface SanitizedPreambleMessage {
  readonly message: ChatMessage;
  readonly application?: PreambleHistoryEvidence;
}

export type SanitizePreamblePrefixesResult =
  | { readonly kind: 'sanitized'; readonly messages: readonly SanitizedPreambleMessage[] }
  | { readonly kind: 'not-yet-persisted'; readonly reason: string }
  | { readonly kind: 'mismatch'; readonly reason: string };

export function collectPreambleHistoryEvidence(
  rows: readonly LedgerRow[],
): readonly PreambleHistoryEvidence[] {
  const collector = new PreambleHistoryCollector();
  collector.add(rows);
  return collector.finish();
}

export class PreambleHistoryCollector {
  readonly #evidence: PreambleHistoryEvidence[] = [];
  readonly #sourceOrdinals: number[] = [];
  readonly #activeApplications: number[] = [];
  #pendingPreambles: readonly AppliedPreambleReference[] | null = null;

  add(rows: readonly LedgerRow[]): void {
    for (const row of rows) {
      if (row.kind === 'user-input' && !row.detail.steer) this.#activeApplications.length = 0;
      if (this.#pendingPreambles !== null) {
        if (row.kind !== 'user-input' || !row.detail.preambleBoundary || !row.detail.preamblePrefixReceipt) {
          throw new Error('Preamble application notice is not adjacent to its input receipt');
        }
        this.#activeApplications.push(this.#evidence.length);
        this.#sourceOrdinals.push(row.ordinal);
        this.#evidence.push({
          receipt: row.detail.preamblePrefixReceipt,
          boundary: row.detail.preambleBoundary,
          preambles: this.#pendingPreambles,
          requiresNativeOccurrence: false,
        });
        this.#pendingPreambles = null;
      } else if (row.kind === 'notice' && isPreambleApplicationNoticeDetail(row.detail)) {
        this.#pendingPreambles = row.detail.preambles.map(preamble => ({ ...preamble }));
      } else if (row.kind === 'user-input' && row.detail.preamblePrefixReceipt) {
        throw new Error('Preamble input receipt has no adjacent application notice');
      } else if (row.kind === 'session' && row.providerMeta?.garconPreambleHistory !== undefined) {
        const retained = parseRetainedEvidence(row.providerMeta.garconPreambleHistory);
        this.#evidence.push(...retained);
        this.#sourceOrdinals.push(...retained.map(() => row.ordinal));
      } else if (row.kind === 'run-ended' && row.origin === 'provider') {
        for (const index of this.#activeApplications) {
          this.#evidence[index] = { ...this.#evidence[index]!, requiresNativeOccurrence: true };
        }
        this.#activeApplications.length = 0;
      }
    }
  }

  finish(): readonly PreambleHistoryEvidence[] {
    if (this.#pendingPreambles !== null) throw new Error('Preamble application notice is not adjacent to its input receipt');
    return this.#evidence;
  }

  finishBefore(ordinal: number): readonly PreambleHistoryEvidence[] {
    return this.finish().filter((_entry, index) => this.#sourceOrdinals[index]! < ordinal);
  }
}

// Clear retains only sanitation receipts, never the deleted prompt or preamble body.
// Collection reads every session row in the binding, so later session facts need no copying.
export function retainedPreambleHistoryMetadata(evidence: readonly PreambleHistoryEvidence[]): JsonObject | null {
  if (evidence.length === 0) return null;
  return {
    garconPreambleHistory: evidence.map((entry) => ({
      receipt: { ...entry.receipt },
      boundary: { ...entry.boundary },
      preambles: entry.preambles.map((preamble) => ({ ...preamble })),
      requiresNativeOccurrence: entry.requiresNativeOccurrence,
    })),
  };
}

function parseRetainedEvidence(value: unknown): PreambleHistoryEvidence[] {
  if (!Array.isArray(value)) throw new Error('Invalid retained preamble history');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid retained preamble history');
    const receipt = parsePreamblePrefixReceipt(entry.receipt);
    const boundary = normalizePendingPreambleBoundary(entry.boundary);
    const application = { type: 'preamble-application', preambles: entry.preambles };
    if (!receipt || !boundary || !isPreambleApplicationNoticeDetail(application)
      || typeof entry.requiresNativeOccurrence !== 'boolean') {
      throw new Error('Invalid retained preamble history');
    }
    return { receipt, boundary, preambles: application.preambles, requiresNativeOccurrence: entry.requiresNativeOccurrence };
  });
}

export function sanitizeRecordedPreamblePrefixes(input: {
  readonly messages: readonly ChatMessage[];
  readonly evidence: readonly PreambleHistoryEvidence[];
}): SanitizePreamblePrefixesResult {
  if (input.evidence.length === 0) {
    return {
      kind: 'sanitized',
      messages: input.messages.map((message) => ({ message })),
    };
  }
  const used = new Set<number>();
  const messages: SanitizedPreambleMessage[] = [];
  for (const message of input.messages) {
    if (!(message instanceof UserMessage) || message.metadata?.contentMode === 'literal'
      || !message.content.startsWith(PREAMBLE_OPEN_PREFIX)) {
      messages.push({ message });
      continue;
    }
    if (!hasVersionOneOpeningFrame(message.content)) {
      return { kind: 'mismatch', reason: 'unknown preamble frame' };
    }
    const matchingSignatures = new Map<string, number[]>();
    for (const [index, candidate] of input.evidence.entries()) {
      const prefix = message.content.slice(0, candidate.receipt.codeUnitLength);
      if (preamblePrefixSha256(prefix) !== candidate.receipt.sha256) {
        continue;
      }
      const signature = `${candidate.receipt.codeUnitLength}:${candidate.receipt.sha256}`;
      const indices = matchingSignatures.get(signature) ?? [];
      indices.push(index);
      matchingSignatures.set(signature, indices);
    }
    if (matchingSignatures.size !== 1) {
      return { kind: 'mismatch', reason: 'preamble prefix hash mismatch' };
    }
    const evidenceIndex = matchingSignatures.values().next().value?.find((index) => !used.has(index));
    if (evidenceIndex === undefined) {
      return { kind: 'mismatch', reason: 'preamble prefix receipt already consumed' };
    }
    const evidence = input.evidence[evidenceIndex]!;
    const prefix = message.content.slice(0, evidence.receipt.codeUnitLength);
    used.add(evidenceIndex);
    messages.push({
      message: new UserMessage(
        message.timestamp,
        message.content.slice(evidence.receipt.codeUnitLength),
        message.images,
        message.metadata,
        message.presentation,
      ),
      application: evidence,
    });
  }
  if (hasMissingRequiredNativeOccurrence(input.evidence, used)) {
    return {
      kind: 'not-yet-persisted',
      reason: 'completed preamble turn is absent from native history',
    };
  }
  return { kind: 'sanitized', messages };
}

function hasMissingRequiredNativeOccurrence(
  evidence: readonly PreambleHistoryEvidence[],
  used: ReadonlySet<number>,
): boolean {
  const requiredBySignature = new Map<string, number>();
  const observedBySignature = new Map<string, number>();
  for (const [index, entry] of evidence.entries()) {
    const signature = receiptSignature(entry.receipt);
    if (entry.requiresNativeOccurrence) {
      requiredBySignature.set(signature, (requiredBySignature.get(signature) ?? 0) + 1);
    }
    if (used.has(index)) {
      observedBySignature.set(signature, (observedBySignature.get(signature) ?? 0) + 1);
    }
  }
  return [...requiredBySignature].some(
    ([signature, required]) => (observedBySignature.get(signature) ?? 0) < required,
  );
}

function receiptSignature(receipt: PreamblePrefixReceipt): string {
  return `${receipt.codeUnitLength}:${receipt.sha256}`;
}

function hasVersionOneOpeningFrame(content: string): boolean {
  const end = content.indexOf('\n');
  return end >= 0 && content.slice(0, end) === '<garcon-preambles version="1">';
}
