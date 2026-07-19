import {
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
} from '@garcon/common/agents';
import { isArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import { createLogger } from '@garcon/server-agent-common/lib/log';

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

export interface DirectNativePathChatEntry {
  agentId: string;
  nativePath?: string;
}

export interface DirectNativePathRegistry {
  getRegistry(): { sessions: Record<string, DirectNativePathChatEntry> };
  saveRegistry(snapshot: { sessions: Record<string, DirectNativePathChatEntry> }): Promise<void>;
}

export async function migrateDirectNativePaths(
  registry: DirectNativePathRegistry,
  resolveNativePath: (session: DirectNativePathChatEntry) => Promise<string | null>,
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
