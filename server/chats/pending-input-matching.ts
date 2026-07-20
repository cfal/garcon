import crypto from 'node:crypto';
import type { ChatImage, UserMessage } from '../../common/chat-types.js';
import type { PendingUserInputRecord } from './pending-user-input-store.js';

const PENDING_ECHO_MAX_AFTER_MS = 5 * 60 * 1000;

export interface IdentitylessEvidenceClaim {
  count: number;
  messageAt: number;
}

export interface PendingInputMatches {
  requestIds: Set<string>;
  identitylessRequestIds: Set<string>;
  identitylessEvidence: Map<string, IdentitylessEvidenceClaim>;
}

interface PendingUserInputImageEvidence {
  name: string;
  mimeType?: string;
  dataSha256: string;
  dataLength: number;
}

function imageEvidence(images: ChatImage[] | undefined): PendingUserInputImageEvidence[] {
  return (images ?? []).map((image) => ({
    name: image.name,
    ...(image.mimeType ? { mimeType: image.mimeType } : {}),
    dataSha256: crypto.createHash('sha256').update(image.data).digest('hex'),
    dataLength: image.data.length,
  }));
}

function imagesMatch(record: PendingUserInputRecord, images: ChatImage[] | undefined): boolean {
  const leftImages = imageEvidence(record.images);
  const rightImages = imageEvidence(images);
  return leftImages.length === rightImages.length && leftImages.every((image, index) => {
    const candidate = rightImages[index];
    return candidate !== undefined
      && image.dataSha256 === candidate.dataSha256
      && image.dataLength === candidate.dataLength
      && image.name === candidate.name
      && image.mimeType === candidate.mimeType;
  });
}

function isUnidentifiedPendingEcho(record: PendingUserInputRecord, message: UserMessage): boolean {
  if (message.metadata?.clientRequestId) return false;
  if (record.turnId && message.metadata?.turnId && record.turnId !== message.metadata.turnId) {
    return false;
  }
  if (record.content !== message.content || !imagesMatch(record, message.images)) return false;
  const pendingAt = Date.parse(record.createdAt);
  const messageAt = Date.parse(message.timestamp);
  return Number.isFinite(pendingAt)
    && Number.isFinite(messageAt)
    && messageAt >= pendingAt
    && messageAt <= pendingAt + PENDING_ECHO_MAX_AFTER_MS;
}

function identitylessEvidenceKey(message: UserMessage): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    timestamp: message.timestamp,
    content: message.content,
    images: message.images ?? [],
    turnId: message.metadata?.turnId ?? null,
  })).digest('hex');
}

export function matchingRequestIds(
  records: PendingUserInputRecord[],
  messages: UserMessage[],
  claimedIdentitylessEvidence: ReadonlyMap<string, IdentitylessEvidenceClaim>,
  allowIdentityless = true,
): PendingInputMatches {
  const matchedMessageIndexes = new Set<number>();
  const requestIds = new Set<string>();
  const identitylessRequestIds = new Set<string>();
  const identitylessEvidence = new Map<string, IdentitylessEvidenceClaim>();
  const identitylessOccurrences = new Map<number, { key: string; occurrence: number; messageAt: number }>();
  const occurrenceCounts = new Map<string, number>();

  messages.forEach((message, index) => {
    if (message.metadata?.clientRequestId) return;
    const key = identitylessEvidenceKey(message);
    const occurrence = (occurrenceCounts.get(key) ?? 0) + 1;
    occurrenceCounts.set(key, occurrence);
    identitylessOccurrences.set(index, {
      key,
      occurrence,
      messageAt: Date.parse(message.timestamp),
    });
  });

  for (const record of records) {
    const messageIndex = messages.findIndex(
      (message, index) => (
        !matchedMessageIndexes.has(index)
        && message.metadata?.clientRequestId === record.clientRequestId
      ),
    );
    if (messageIndex < 0) continue;
    matchedMessageIndexes.add(messageIndex);
    requestIds.add(record.clientRequestId);
  }

  if (!allowIdentityless) return { requestIds, identitylessRequestIds, identitylessEvidence };

  const candidates: Array<{
    record: PendingUserInputRecord;
    recordIndex: number;
    messageIndex: number;
    evidence: { key: string; occurrence: number; messageAt: number };
    distanceMs: number;
  }> = [];
  records.forEach((record, recordIndex) => {
    if (requestIds.has(record.clientRequestId)) return;
    messages.forEach((message, messageIndex) => {
      if (matchedMessageIndexes.has(messageIndex) || !isUnidentifiedPendingEcho(record, message)) return;
      const evidence = identitylessOccurrences.get(messageIndex);
      if (
        !evidence
        || evidence.occurrence <= (claimedIdentitylessEvidence.get(evidence.key)?.count ?? 0)
      ) return;
      candidates.push({
        record,
        recordIndex,
        messageIndex,
        evidence,
        distanceMs: Math.abs(evidence.messageAt - Date.parse(record.createdAt)),
      });
    });
  });
  candidates.sort((left, right) => (
    left.distanceMs - right.distanceMs
    || left.recordIndex - right.recordIndex
    || left.messageIndex - right.messageIndex
  ));

  for (const candidate of candidates) {
    if (matchedMessageIndexes.has(candidate.messageIndex) || requestIds.has(candidate.record.clientRequestId)) {
      continue;
    }
    matchedMessageIndexes.add(candidate.messageIndex);
    requestIds.add(candidate.record.clientRequestId);
    identitylessRequestIds.add(candidate.record.clientRequestId);
    const prior = identitylessEvidence.get(candidate.evidence.key);
    identitylessEvidence.set(candidate.evidence.key, {
      count: Math.max(prior?.count ?? 0, candidate.evidence.occurrence),
      messageAt: candidate.evidence.messageAt,
    });
  }

  return { requestIds, identitylessRequestIds, identitylessEvidence };
}
