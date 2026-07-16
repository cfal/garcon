import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { stripFirstUserSeed } from '../../agents/shared/transcript-seed.js';
import { loadDetachedSearchMessages } from '../../agents/search-transcript-loader.js';
import { loadCarriedSearchMessages } from './carryover-loader.js';
import { projectHistoricalSearchMessages } from './message-projector.js';
import type { TranscriptBuildSource } from './source-types.js';
import type { HistoricalSearchMessageRow } from './worker-protocol.js';

async function sourceProbe(source: TranscriptBuildSource['source']): Promise<string | null> {
  if (source.kind === 'opencode-api') {
    return null;
  }
  if (source.kind === 'cursor-acp') {
    return null;
  }
  const stat = await fs.stat(source.nativePath);
  return `${source.kind}:${source.nativePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

export async function probeTranscriptBuildSource(
  buildSource: TranscriptBuildSource,
): Promise<string | null> {
  const source = await sourceProbe(buildSource.source);
  if (!source) return null;
  const carryKey = buildSource.carryOver ? `:carry:${buildSource.carryOver.chatRevision}` : '';
  return `${source}${carryKey}`;
}

function digestRows(rows: HistoricalSearchMessageRow[]): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    hash.update(String(row.messageOrdinal));
    hash.update('\0');
    hash.update(row.role);
    hash.update('\0');
    hash.update(row.timestamp ?? '');
    hash.update('\0');
    hash.update(row.body);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function loadTranscriptBuildRows(
  chatId: string,
  buildSource: TranscriptBuildSource,
): Promise<{ rows: HistoricalSearchMessageRow[]; sourceKey: string }> {
  const beforeProbe = await sourceProbe(buildSource.source);
  const native = await loadDetachedSearchMessages(buildSource.source);
  const carried = buildSource.carryOver
    ? await loadCarriedSearchMessages(chatId, buildSource.carryOver, {
        agentId: buildSource.currentAgentId,
        model: buildSource.currentModel,
      })
    : [];
  const messages = carried.length > 0 ? [...carried, ...stripFirstUserSeed(native)] : native;
  const rows = projectHistoricalSearchMessages(messages);
  const afterProbe = await sourceProbe(buildSource.source);
  if (beforeProbe !== afterProbe) throw new Error('Transcript source changed during indexing');
  const carryKey = buildSource.carryOver ? `:carry:${buildSource.carryOver.chatRevision}` : '';
  const stableProbe = afterProbe ?? `${buildSource.source.kind}:${chatId}:${Date.now()}`;
  return { rows, sourceKey: `${stableProbe}${carryKey}:sha256:${digestRows(rows)}` };
}
