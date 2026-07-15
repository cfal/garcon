import {
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
} from '../../../common/agents.js';
import { isArtificialNativePath } from '../../chats/artificial-native-path.js';
import type { ChatRegistryEntry, IChatRegistry } from '../../chats/store.js';
import { createLogger } from '../../lib/log.js';

const logger = createLogger('agents:direct:native-path-migration');
const DIRECT_AGENT_IDS = new Set<string>([
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
]);

export interface DirectNativePathMigrationResult {
  converted: number;
  skipped: number;
  failed: number;
}

export async function migrateDirectNativePaths(
  registry: Pick<IChatRegistry, 'getRegistry' | 'saveRegistry'>,
  resolveNativePath: (session: ChatRegistryEntry) => Promise<string | null>,
): Promise<DirectNativePathMigrationResult> {
  const snapshot = registry.getRegistry();
  const result: DirectNativePathMigrationResult = {
    converted: 0,
    skipped: 0,
    failed: 0,
  };
  let dirty = false;

  for (const [chatId, session] of Object.entries(snapshot.sessions)) {
    if (!DIRECT_AGENT_IDS.has(session.agentId)) continue;
    if (!isArtificialNativePath(session.nativePath)) continue;

    try {
      const resolved = await resolveNativePath(session);
      if (!resolved || isArtificialNativePath(resolved)) {
        result.skipped += 1;
        continue;
      }

      session.nativePath = resolved;
      result.converted += 1;
      dirty = true;
    } catch (error: unknown) {
      result.failed += 1;
      logger.warn(
        `chat ${chatId}: failed to resolve Direct native path:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (dirty) {
    await registry.saveRegistry(snapshot);
  }
  if (result.converted || result.skipped || result.failed) {
    logger.info(
      `Direct native path migration: converted=${result.converted} skipped=${result.skipped} failed=${result.failed}`,
    );
  }

  return result;
}
