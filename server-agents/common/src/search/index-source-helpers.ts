import crypto from 'node:crypto';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage } from '@garcon/common/chat-types';
import {
  AgentTranscriptIndexError,
  type AgentTranscriptIndexLoadLimits,
  type AgentTranscriptIndexSourceRef,
} from '@garcon/server-agent-interface';
import { readJsonlLineEntries } from '../shared/history-loader-utils.js';

function failure(code: string, retryable: boolean, refreshSource = false): AgentTranscriptIndexError {
  return new AgentTranscriptIndexError({
    kind: 'agent-transcript-index-failure',
    code,
    retryable,
    refreshSource,
  });
}

export function parseFileIndexSource(
  source: AgentTranscriptIndexSourceRef,
  ownerId: string,
): { readonly nativePath: string } {
  const nativePath = source.value.nativePath;
  if (source.ownerId !== ownerId
      || source.schemaVersion !== 1
      || typeof nativePath !== 'string'
      || nativePath.length === 0) {
    throw failure('SOURCE_DESCRIPTOR_INVALID', false);
  }
  return { nativePath };
}

export async function probeFileIndexSource(
  source: AgentTranscriptIndexSourceRef,
  ownerId: string,
  signal: AbortSignal,
): Promise<{ readonly revision: string }> {
  signal.throwIfAborted();
  const { nativePath } = parseFileIndexSource(source, ownerId);
  try {
    const value = await stat(nativePath, { bigint: true });
    signal.throwIfAborted();
    return {
      revision: `file-v1:${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`,
    };
  } catch (error) {
    signal.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    throw failure(code === 'ENOENT' ? 'SOURCE_NOT_FOUND' : 'SOURCE_STAT_FAILED', true);
  }
}

function messageBytes(message: ChatMessage): number {
  return Buffer.byteLength(JSON.stringify(message));
}

export async function* yieldBoundedMessageBatches(
  messages: readonly ChatMessage[],
  limits: AgentTranscriptIndexLoadLimits,
  signal: AbortSignal,
): AsyncIterable<readonly ChatMessage[]> {
  let batch: ChatMessage[] = [];
  let batchBytes = 0;
  for (const message of messages) {
    signal.throwIfAborted();
    const bytes = messageBytes(message);
    if (bytes > limits.maxRecordBytes || bytes > limits.maxBatchBytes) {
      throw failure('SOURCE_RECORD_TOO_LARGE', false);
    }
    if (batch.length > 0 && (
      batch.length >= limits.maxMessagesPerBatch
      || batchBytes + bytes > limits.maxBatchBytes
    )) {
      yield batch;
      batch = [];
      batchBytes = 0;
      await Promise.resolve();
    }
    batch.push(message);
    batchBytes += bytes;
  }
  if (batch.length > 0) yield batch;
}

export async function createCompleteJsonlSnapshot(input: {
  readonly nativePath: string;
  readonly scratchDirectory: string;
  readonly maxRecordBytes: number;
  readonly signal: AbortSignal;
}): Promise<{ readonly path: string; remove(): Promise<void> }> {
  input.signal.throwIfAborted();
  await mkdir(input.scratchDirectory, { recursive: true, mode: 0o700 });
  const snapshotPath = path.join(input.scratchDirectory, `${crypto.randomUUID()}.jsonl`);
  const file = await open(snapshotPath, 'wx', 0o600);
  try {
    for await (const entry of readJsonlLineEntries(input.nativePath, {
      completeLinesOnly: true,
      includeEmptyLines: true,
      maxLineBytes: input.maxRecordBytes,
      signal: input.signal,
    })) {
      input.signal.throwIfAborted();
      if (entry.line.trim()) {
        try {
          JSON.parse(entry.line);
        } catch {
          throw failure('SOURCE_RECORD_INVALID', false);
        }
      }
      await file.write(`${entry.line}\n`);
    }
    input.signal.throwIfAborted();
    await file.close();
    return {
      path: snapshotPath,
      remove: () => rm(snapshotPath, { force: true }),
    };
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(snapshotPath, { force: true });
    input.signal.throwIfAborted();
    if (error instanceof AgentTranscriptIndexError) throw error;
    if (error instanceof Error && /record exceeds/u.test(error.message)) {
      throw failure('SOURCE_RECORD_TOO_LARGE', false);
    }
    throw failure('SOURCE_READ_FAILED', true);
  }
}

export function sourceFailure(
  code: string,
  retryable: boolean,
  refreshSource = false,
): AgentTranscriptIndexError {
  return failure(code, retryable, refreshSource);
}
