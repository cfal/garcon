import { PreambleProjectPathService } from './project-path-service.js';
import { PreambleService } from './service.js';
import { PreambleStore } from './store.js';

export async function initializePreambleService(workspaceDir: string): Promise<PreambleService> {
  const store = new PreambleStore(workspaceDir);
  await store.init();
  return new PreambleService({ store, projectPaths: new PreambleProjectPathService() });
}
