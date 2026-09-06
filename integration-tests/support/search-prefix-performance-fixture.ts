import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptSearchAllowedChat } from '../../common/chat-search.js';
import {
  closeSearchDatabase,
  finishChatSync,
  insertRowsBatch,
  openSearchDatabase,
  planChatSync,
} from '../../server-agents/common/src/search/schema.js';
import { mulberry32, syntheticBody } from './synthetic-text.js';

const PERFORMANCE_FIXTURE_ROOT = join(homedir(), 'tmp');

export interface SearchPrefixPerformanceFixture {
  readonly workspaceDirectory: string;
  readonly allowedChats: readonly TranscriptSearchAllowedChat[];
  readonly markerTerm: string;
  readonly secondaryMarkerTerm: string;
  dispose(): Promise<void>;
}

export async function createSearchPrefixPerformanceFixture(options: {
  readonly chatCount: number;
  readonly rowsPerChat: number;
  readonly bodyCharacters: number;
  readonly name: string;
}): Promise<SearchPrefixPerformanceFixture> {
  await mkdir(PERFORMANCE_FIXTURE_ROOT, { recursive: true });
  const workspaceDirectory = await mkdtemp(join(
    PERFORMANCE_FIXTURE_ROOT,
    `garcon-search-${options.name}-`,
  ));
  const markerTerm = `${options.name}marker`;
  const secondaryMarkerTerm = `${options.name}secondary`;
  const markerSuffix = ` ${markerTerm} ${secondaryMarkerTerm}`;
  const random = mulberry32(73);
  const generated = syntheticBody(random, options.bodyCharacters);
  const body = `${generated.slice(0, options.bodyCharacters - markerSuffix.length)}${markerSuffix}`;
  if (body.length !== options.bodyCharacters) {
    throw new Error('Search prefix performance body length is invalid');
  }

  const opened = await openSearchDatabase(join(
    workspaceDirectory,
    'transcript-search',
    'index.sqlite',
  ));
  const allowedChats: TranscriptSearchAllowedChat[] = [];
  try {
    for (let index = 0; index < options.chatCount; index += 1) {
      const indexSuffix = String(index).padStart(4, '0');
      const chatId = `chat-${options.name}-${indexSuffix}`;
      const transcriptViewId = `view-${options.name}-${indexSuffix}`;
      const plan = planChatSync(opened.db, {
        mode: 'replace',
        chatId,
        transcriptViewId,
        targetThrough: options.rowsPerChat,
        expectedAfterOrdinal: 0,
      });
      if (plan.plan !== 'build') throw new Error('Search prefix performance build was not admitted');
      insertRowsBatch(opened.db, {
        chatId,
        transcriptViewId,
        rows: Array.from({ length: options.rowsPerChat }, (_, rowIndex) => ({
          ordinal: rowIndex + 1,
          role: rowIndex % 2 === 0 ? 'user' as const : 'assistant' as const,
          timestamp: '2026-01-01T00:00:00.000Z',
          body,
        })),
        advanceTo: options.rowsPerChat,
      });
      finishChatSync(opened.db, { chatId, transcriptViewId });
      allowedChats.push({
        chatId,
        transcriptViewId,
        throughOrdinal: options.rowsPerChat,
      });
    }
  } catch (error) {
    closeSearchDatabase(opened.db);
    await rm(workspaceDirectory, { recursive: true, force: true });
    throw error;
  }
  closeSearchDatabase(opened.db);

  return {
    workspaceDirectory,
    allowedChats,
    markerTerm,
    secondaryMarkerTerm,
    dispose: () => rm(workspaceDirectory, { recursive: true, force: true }),
  };
}
