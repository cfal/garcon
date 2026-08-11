import { expect } from 'bun:test';
import { GarconApiError } from './garcon-client.js';
import {
  LIVE_TURN_TIMEOUT_MS,
} from './live-agent.js';
import type { IntegrationFixture } from './integration-fixture.js';

const TRANSCRIPT_NOT_YET_PERSISTED = 'TRANSCRIPT_NOT_YET_PERSISTED';
const SOURCE_SETTLEMENT_RETRY_CODES = new Set([
  TRANSCRIPT_NOT_YET_PERSISTED,
  'SESSION_BUSY',
]);

export async function expectTranscriptNotYetPersisted(
  promise: Promise<unknown>,
): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(GarconApiError);
  expect(failure).toMatchObject({
    status: 409,
    body: {
      errorCode: TRANSCRIPT_NOT_YET_PERSISTED,
      retryable: true,
    },
  });
}

export function forkWhenTranscriptPersists(
  fixture: IntegrationFixture,
  sourceChatId: string,
  chatId: string,
): Promise<void> {
  return forkWithRetry(
    fixture,
    sourceChatId,
    chatId,
    new Set([TRANSCRIPT_NOT_YET_PERSISTED]),
  );
}

export function forkAfterSourceSettles(
  fixture: IntegrationFixture,
  sourceChatId: string,
  chatId: string,
): Promise<void> {
  return forkWithRetry(
    fixture,
    sourceChatId,
    chatId,
    SOURCE_SETTLEMENT_RETRY_CODES,
  );
}

export async function expectMessageNotYetInNativeHistory(
  promise: Promise<unknown>,
): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(GarconApiError);
  expect(failure).toMatchObject({
    status: 409,
    body: {
      errorCode: 'MESSAGE_NOT_IN_NATIVE_HISTORY',
      retryable: true,
    },
  });
}

// Retries a message-point fork while the provider file trails the settled
// projection; the settled boundary binds the point's native alias, so the
// retry converges once the turn settles with the pinned prefix persisted.
export function forkAtMessageWhenPersisted(
  fixture: IntegrationFixture,
  sourceChatId: string,
  chatId: string,
  upToSeq: number,
): Promise<void> {
  return forkWithRetry(
    fixture,
    sourceChatId,
    chatId,
    new Set([
      TRANSCRIPT_NOT_YET_PERSISTED,
      'MESSAGE_NOT_IN_NATIVE_HISTORY',
      'SOURCE_REVISION_CHANGED',
    ]),
    upToSeq,
  );
}

async function forkWithRetry(
  fixture: IntegrationFixture,
  sourceChatId: string,
  chatId: string,
  retryableErrorCodes: ReadonlySet<string>,
  upToSeq?: number,
): Promise<void> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fixture.client.forkChat({
        sourceChatId,
        chatId,
        ...(upToSeq === undefined ? {} : { upToSeq }),
      });
      return;
    } catch (error) {
      const errorCode = forkErrorCode(error);
      if (!errorCode || !retryableErrorCodes.has(errorCode)) throw error;
      await Bun.sleep(25);
    }
  }
  throw new Error(`Transcript for ${sourceChatId} did not become forkable.`);
}

function forkErrorCode(error: unknown): string | null {
  if (
    !(error instanceof GarconApiError)
    || error.status !== 409
    || !isRecord(error.body)
    || typeof error.body.errorCode !== 'string'
    || error.body.retryable !== true
  ) {
    return null;
  }
  return error.body.errorCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
