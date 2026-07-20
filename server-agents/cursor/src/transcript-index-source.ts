import { stat } from 'node:fs/promises';
import type {
  AgentTranscriptIndexSourceRef,
  AgentTranscriptIndexerModule,
} from '@garcon/server-agent-interface';
import {
  sourceFailure,
  yieldBoundedMessageBatches,
} from '@garcon/server-agent-common/search/index-source-helpers';
import { normalizeCursorBlobs, readCursorBlobs } from './agents/cursor/history-loader.js';

function parseSource(source: AgentTranscriptIndexSourceRef) {
  const sessionId = source.value.sessionId;
  const projectPath = source.value.projectPath;
  const storePath = source.value.storePath;
  if (source.ownerId !== 'cursor'
      || source.schemaVersion !== 1
      || typeof sessionId !== 'string'
      || typeof projectPath !== 'string'
      || typeof storePath !== 'string') {
    throw sourceFailure('SOURCE_DESCRIPTOR_INVALID', false);
  }
  return { sessionId, projectPath, storePath };
}

async function fingerprint(path: string, optional: boolean): Promise<string> {
  try {
    const value = await stat(path, { bigint: true });
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw sourceFailure(
      (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'SOURCE_NOT_FOUND' : 'SOURCE_STAT_FAILED',
      true,
    );
  }
}

const moduleDefinition: AgentTranscriptIndexerModule = {
  integrationId: 'cursor',
  apiVersion: 1,
  create() {
    return {
      async probe(source, signal) {
        signal.throwIfAborted();
        const { storePath } = parseSource(source);
        const [database, wal] = await Promise.all([
          fingerprint(storePath, false),
          fingerprint(`${storePath}-wal`, true),
        ]);
        signal.throwIfAborted();
        return { revision: `cursor-v1:${database}:${wal}` };
      },
      async *load(request) {
        request.signal.throwIfAborted();
        const source = parseSource(request.source);
        let messages: ReturnType<typeof normalizeCursorBlobs>;
        try {
          messages = normalizeCursorBlobs(readCursorBlobs(source.storePath, {
            signal: request.signal,
            maxBlobBytes: request.limits.maxRecordBytes,
          }));
        } catch (error) {
          request.signal.throwIfAborted();
          if (error instanceof Error && /record exceeds/u.test(error.message)) {
            throw sourceFailure('SOURCE_RECORD_TOO_LARGE', false);
          }
          throw sourceFailure('SOURCE_READ_FAILED', true);
        }
        yield* yieldBoundedMessageBatches(messages, request.limits, request.signal);
      },
      async close() {},
    };
  },
};

export default moduleDefinition;
