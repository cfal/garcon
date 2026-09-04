import crypto from 'node:crypto';
import { UserMessage, type ChatMessage } from '../../common/chat-types.js';
import {
  PREAMBLE_OPEN_PREFIX,
  type PreamblePrefixReceipt,
} from '../../common/preamble-prefix.js';
import {
  isPreambleApplicationNoticeDetail,
  type AppliedPreambleReference,
} from '../../common/transcript-notice-details.js';
import type { PendingPreambleBoundary } from '../../common/preambles.js';
import type { LedgerRow } from './contracts.js';

export interface PreambleHistoryEvidence {
  readonly receipt: PreamblePrefixReceipt;
  readonly boundary: PendingPreambleBoundary;
  readonly preambles: readonly AppliedPreambleReference[];
}

export interface SanitizedPreambleMessage {
  readonly message: ChatMessage;
  readonly application?: PreambleHistoryEvidence;
}

export type SanitizePreamblePrefixesResult =
  | { readonly kind: 'sanitized'; readonly messages: readonly SanitizedPreambleMessage[] }
  | { readonly kind: 'mismatch'; readonly reason: string };

export function collectPreambleHistoryEvidence(
  rows: readonly LedgerRow[],
): readonly PreambleHistoryEvidence[] {
  const evidence: PreambleHistoryEvidence[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.kind === 'notice' && isPreambleApplicationNoticeDetail(row.detail)) {
      const input = rows[index + 1];
      if (
        input?.kind !== 'user-input'
        || !input.detail.preambleBoundary
        || !input.detail.preamblePrefixReceipt
      ) throw new Error('Preamble application notice is not adjacent to its input receipt');
      const receipt = input.detail.preamblePrefixReceipt;
      evidence.push({
        receipt,
        boundary: input.detail.preambleBoundary,
        preambles: row.detail.preambles.map((preamble) => ({ ...preamble })),
      });
      index += 1;
      continue;
    }
    if (row.kind === 'user-input' && row.detail.preamblePrefixReceipt) {
      throw new Error('Preamble input receipt has no adjacent application notice');
    }
  }
  return evidence;
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
    if (!(message instanceof UserMessage) || !message.content.startsWith(PREAMBLE_OPEN_PREFIX)) {
      messages.push({ message });
      continue;
    }
    if (!hasVersionOneOpeningFrame(message.content)) {
      return { kind: 'mismatch', reason: 'unknown preamble frame' };
    }
    const matchingSignatures = new Map<string, number[]>();
    for (const [index, candidate] of input.evidence.entries()) {
      const prefix = message.content.slice(0, candidate.receipt.codeUnitLength);
      if (crypto.createHash('sha256').update(prefix).digest('hex') !== candidate.receipt.sha256) {
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
  return { kind: 'sanitized', messages };
}

function hasVersionOneOpeningFrame(content: string): boolean {
  const end = content.indexOf('\n');
  return end >= 0 && content.slice(0, end) === '<garcon-preambles version="1">';
}
