import { createHash } from 'crypto';
import type { ChatMessage } from '../../../common/chat-types.js';
import { stripFirstUserSeed } from '../../agents/shared/transcript-seed.js';
import {
  loadDetachedSearchMessageBatches,
  probeDetachedSearchSource,
} from '../../agents/search-transcript-loader.js';
import { loadCarriedSearchMessages } from './carryover-loader.js';
import { projectSearchMessage } from './message-projector.js';
import type { TranscriptBuildSource } from './source-types.js';
import type { HistoricalSearchMessageRow } from './worker-protocol.js';

const HISTORICAL_BATCH_SIZE = 250;

function descriptorHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function probeTranscriptBuildSource(
  buildSource: TranscriptBuildSource,
): Promise<string | null> {
  const source = await probeDetachedSearchSource(buildSource.source);
  if (!source) return null;
  const carryKey = buildSource.carryOver ? `:carry:${buildSource.carryOver.chatRevision}` : '';
  return `${source}${carryKey}`;
}

export async function loadTranscriptBuildBatches(
  chatId: string,
  buildSource: TranscriptBuildSource,
  options: {
    signal: AbortSignal;
    onRows(rows: HistoricalSearchMessageRow[]): void | Promise<void>;
  },
): Promise<{ sourceKey: string; rowCount: number }> {
  const beforeProbe = await probeDetachedSearchSource(buildSource.source);
  const digest = createHash('sha256');
  let sourceOrdinal = 0;
  let rowCount = 0;
  let firstNativeUserSeen = false;

  const projectBatch = async (messages: readonly ChatMessage[]): Promise<void> => {
    if (options.signal.aborted) throw new DOMException('Transcript search load cancelled', 'AbortError');
    const rows: HistoricalSearchMessageRow[] = [];
    for (const message of messages) {
      sourceOrdinal += 1;
      const row = projectSearchMessage(message);
      if (!row) continue;
      const historical = { ...row, messageOrdinal: sourceOrdinal };
      rows.push(historical);
      digest.update(String(historical.messageOrdinal));
      digest.update('\0');
      digest.update(historical.role);
      digest.update('\0');
      digest.update(historical.timestamp ?? '');
      digest.update('\0');
      digest.update(historical.body);
      digest.update('\0');
      rowCount += 1;
    }
    await options.onRows(rows);
  };

  if (buildSource.carryOver) {
    const carried = await loadCarriedSearchMessages(chatId, buildSource.carryOver, {
      agentId: buildSource.currentAgentId,
      model: buildSource.currentModel,
    });
    for (let index = 0; index < carried.length; index += HISTORICAL_BATCH_SIZE) {
      await projectBatch(carried.slice(index, index + HISTORICAL_BATCH_SIZE));
    }
  }

  for await (const loadedBatch of loadDetachedSearchMessageBatches(buildSource.source, {
    signal: options.signal,
    batchSize: HISTORICAL_BATCH_SIZE,
  })) {
    let batch = loadedBatch;
    if (buildSource.carryOver && !firstNativeUserSeen) {
      firstNativeUserSeen = batch.some((message) => message.type === 'user-message');
      batch = stripFirstUserSeed(batch);
    }
    await projectBatch(batch);
  }

  const afterProbe = await probeDetachedSearchSource(buildSource.source);
  if (beforeProbe !== afterProbe) throw new Error('Transcript source changed during indexing');
  const carryKey = buildSource.carryOver ? `:carry:${buildSource.carryOver.chatRevision}` : '';
  const stableProbe = afterProbe
    ?? `volatile:${buildSource.source.kind}:${descriptorHash(buildSource.source)}`;
  return {
    rowCount,
    sourceKey: `${stableProbe}${carryKey}:sha256:${digest.digest('hex')}`,
  };
}
