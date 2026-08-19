import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { AssistantMessage, UserMessage } from '../../common/chat-types.js';
import type { LedgerRowDraft } from '../../server/ledger/contracts.js';
import { TranscriptLedgerStore } from '../../server/ledger/store.js';
import type { IntegrationFixture } from './integration-fixture.js';
import { mulberry32, syntheticBody } from './synthetic-text.js';

export interface SearchCorpusTier {
  readonly name: 'S' | 'M' | 'L' | 'ISOLATION';
  readonly denseChats: number;
  readonly denseRowsPerChat: number;
  readonly maxChatRows: number;
  readonly sparseChats: number;
  readonly bodyBytes: number;
  readonly oversizedChat: boolean;
}

export const SEARCH_CORPUS_TIER_S: SearchCorpusTier = {
  name: 'S',
  denseChats: 6,
  denseRowsPerChat: 500,
  maxChatRows: 500,
  sparseChats: 6,
  bodyBytes: 780,
  oversizedChat: false,
};

export const SEARCH_CORPUS_TIER_M: SearchCorpusTier = {
  name: 'M',
  denseChats: 43,
  denseRowsPerChat: 2_600,
  maxChatRows: 8_200,
  sparseChats: 263,
  bodyBytes: 780,
  oversizedChat: false,
};

export const SEARCH_CORPUS_TIER_L: SearchCorpusTier = {
  name: 'L',
  denseChats: 172,
  denseRowsPerChat: 2_600,
  maxChatRows: 16_400,
  sparseChats: 134,
  bodyBytes: 780,
  oversizedChat: false,
};

export const SEARCH_CORPUS_TIER_ISOLATION: SearchCorpusTier = {
  name: 'ISOLATION',
  denseChats: 6,
  denseRowsPerChat: 500,
  maxChatRows: 500,
  sparseChats: 2,
  bodyBytes: 780,
  oversizedChat: true,
};

export interface SeededSearchCorpus {
  readonly denseChatIds: readonly string[];
  readonly sparseChatIds: readonly string[];
  readonly oversizedChatId: string | null;
  readonly markerTerm: string;
}

export interface SeededCorpusTotals {
  readonly rows: number;
  readonly bodyBytes: number;
}

export async function createSearchCorpusChats(
  fixture: IntegrationFixture,
  tier: SearchCorpusTier,
): Promise<SeededSearchCorpus> {
  const markerTerm = 'quartzmarker';
  const denseChatIds: string[] = [];
  const sparseChatIds: string[] = [];
  const seedChat = async (content: string): Promise<string> => {
    const chatId = fixture.newChatId();
    const turn = await fixture.client.startDirectChat({
      chatId,
      content,
      projectPath: fixture.dirs.project,
      agent: fixture.directAgents.openAi,
    });
    await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
    return chatId;
  };
  for (let index = 0; index < tier.denseChats; index += 1) {
    denseChatIds.push(await seedChat(`corpus dense seed ${index} ${markerTerm}`));
  }
  for (let index = 0; index < tier.sparseChats; index += 1) {
    sparseChatIds.push(await seedChat(`corpus sparse seed ${index}`));
  }
  const oversizedChatId = tier.oversizedChat
    ? await seedChat('corpus oversized seed')
    : null;
  return { denseChatIds, sparseChatIds, oversizedChatId, markerTerm };
}

export async function bulkAppendCorpusRows(
  workspaceDir: string,
  corpus: SeededSearchCorpus,
  tier: SearchCorpusTier,
): Promise<SeededCorpusTotals> {
  const store = new TranscriptLedgerStore(join(workspaceDir, 'transcript-ledgers'));
  let rows = 0;
  let bodyBytes = 0;
  const appendRows = (chatId: string, rowCount: number, rowBytes: number, seed: number) => {
    const view = store.currentView(chatId);
    if (!view) throw new Error(`Corpus chat ${chatId} has no current view`);
    const random = mulberry32(seed);
    const batch: LedgerRowDraft[] = [];
    const flush = () => {
      if (batch.length === 0) return;
      store.append(chatId, view.viewId, batch.splice(0));
    };
    for (let index = 0; index < rowCount; index += 1) {
      const generated = syntheticBody(random, rowBytes);
      const body = index % 11 === 0 ? `${generated} ${corpus.markerTerm}` : generated;
      bodyBytes += Buffer.byteLength(body, 'utf8');
      const at = '2026-01-01T00:00:00.000Z';
      batch.push(index % 2 === 0
        ? {
            kind: 'user-input',
            at,
            providerMeta: null,
            detail: {
              clientMessageId: null,
              message: new UserMessage(at, body),
              attachments: [],
              steer: false,
            },
          }
        : {
            kind: 'provider-row',
            at,
            providerMeta: null,
            message: new AssistantMessage(at, body),
          });
      if (batch.length === 250) flush();
      rows += 1;
    }
    flush();
  };
  corpus.denseChatIds.forEach((chatId, index) => {
    appendRows(
      chatId,
      index === 0 ? tier.maxChatRows : tier.denseRowsPerChat,
      tier.bodyBytes,
      1_000 + index,
    );
  });
  if (corpus.oversizedChatId) {
    appendRows(corpus.oversizedChatId, 1_500, 48_000, 9_999);
  }
  store.close();
  return { rows, bodyBytes };
}

export function derivedIndexDiskBytes(workspaceDir: string): number {
  const indexPath = join(workspaceDir, 'transcript-search', 'index.sqlite');
  return [indexPath, `${indexPath}-wal`, `${indexPath}-shm`]
    .map((path) => Bun.file(path).size)
    .reduce((sum, size) => sum + size, 0);
}

export function readDerivedIndexSnapshot(workspaceDir: string): {
  readonly userVersion: number;
  readonly chunkCount: number;
  readonly maxChunkId: number;
  readonly stateStamps: ReadonlyArray<{ chatId: string; updatedAt: string }>;
  readonly fileBytes: number;
} {
  const indexPath = join(workspaceDir, 'transcript-search', 'index.sqlite');
  const db = new Database(indexPath, { readonly: true });
  try {
    return {
      userVersion: (db.query('PRAGMA user_version').get() as { user_version: number }).user_version,
      chunkCount: (db.query('SELECT COUNT(*) AS n FROM search_chunks').get() as { n: number }).n,
      maxChunkId: (
        db.query('SELECT COALESCE(MAX(id), 0) AS n FROM search_chunks').get() as { n: number }
      ).n,
      stateStamps: db.query<{ chatId: string; updatedAt: string }, []>(
        'SELECT chat_id AS chatId, updated_at AS updatedAt FROM search_chat_state ORDER BY chat_id',
      ).all(),
      fileBytes: Bun.file(indexPath).size,
    };
  } finally {
    db.close();
  }
}
