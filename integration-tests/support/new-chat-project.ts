import type { GarconTestClient } from './garcon-client.js';

/** Saves one synthetic project so a New Chat browser fixture can select it from the landing list. */
export async function saveNewChatProject(
  client: GarconTestClient,
  projectPath: string,
  executorId = client.executorId,
): Promise<void> {
  const paths = executorId === 'local'
    ? { pinnedProjectPaths: [projectPath], recentProjectPaths: [projectPath] }
    : { byExecutor: { [executorId]: { pinnedPaths: [projectPath], recentPaths: [projectPath], defaultPath: projectPath } } };
  await client.put('/api/v1/app/settings', { paths });
}
