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
  const keys = new Set<string>();
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
      if (keys.has(receipt.applicationKey)) throw new Error('Duplicate preamble application receipt');
      keys.add(receipt.applicationKey);
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
  const byKey = new Map(input.evidence.map((entry) => [entry.receipt.applicationKey, entry]));
  if (byKey.size !== input.evidence.length) {
    return { kind: 'mismatch', reason: 'duplicate application evidence' };
  }
  const used = new Set<string>();
  const messages: SanitizedPreambleMessage[] = [];
  for (const message of input.messages) {
    if (!(message instanceof UserMessage) || !message.content.startsWith(PREAMBLE_OPEN_PREFIX)) {
      messages.push({ message });
      continue;
    }
    const applicationKey = parseOpeningApplicationKey(message.content);
    const evidence = applicationKey ? byKey.get(applicationKey) : undefined;
    if (!applicationKey || !evidence || used.has(applicationKey)) {
      return { kind: 'mismatch', reason: 'unknown preamble application' };
    }
    const prefix = message.content.slice(0, evidence.receipt.codeUnitLength);
    const sha256 = crypto.createHash('sha256').update(prefix).digest('hex');
    if (sha256 !== evidence.receipt.sha256) {
      return { kind: 'mismatch', reason: 'preamble prefix hash mismatch' };
    }
    used.add(applicationKey);
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

function parseOpeningApplicationKey(content: string): string | null {
  const end = content.indexOf('\n');
  if (end < 0) return null;
  const match = /^<garcon-preambles version="1" application="([a-f0-9]{64})">$/u.exec(
    content.slice(0, end),
  );
  return match?.[1] ?? null;
}
