import { join } from 'node:path';
import { parseChatId } from '../../common/chat-id.js';
import { isProviderType, isStoredProjectPath } from '../../common/execution-nodes.js';
import { normalizeChatRegistryEntry } from '../../server/chats/registry-entry-codec.js';
import { CHAT_REGISTRY_VERSION } from '../../server/chats/store.js';
import { ExecutionNodesStore } from '../../server/execution-nodes/store.js';
import { writeJsonFileAtomic } from '../../server/lib/json-file-store.js';

export async function writePersistedChatRegistry(
  workspaceDir: string,
  sessions: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): Promise<void> {
  const entries = Object.entries(sessions).map(([id, entry]) => {
    if (!isProviderType(entry.agentId) || !isStoredProjectPath(entry.projectPath)) {
      throw new Error('Invalid fixture execution target');
    }
    return { chatId: parseChatId(id), entry, target: { agentId: entry.agentId, projectPath: entry.projectPath } };
  });
  const nodes = new ExecutionNodesStore(workspaceDir);
  await nodes.init();
  const locations = await nodes.prepareLocalTargets(entries.map(({ target }) => target));
  await writeJsonFileAtomic(join(workspaceDir, 'chats.json'), {
    version: CHAT_REGISTRY_VERSION,
    sessions: Object.fromEntries(entries.map(({ chatId, entry }, index) => [
      chatId, normalizeChatRegistryEntry({ ...entry, executionLocation: locations[index] }, chatId),
    ])),
  }, { mode: 0o600 });
}
