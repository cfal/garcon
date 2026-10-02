import type { RetainExecutorReferences } from '../executors/reference-writes.js';
import { createLogger } from '../../common/log.js';
import { BUNDLED_PREAMBLES } from './bundled.js';
import { PreambleProjectPathService } from './project-path-service.js';
import { PreambleService } from './service.js';
import { PreambleStore } from './store.js';
import type { SnippetShortNameCoordinator } from '../snippets/short-name-coordinator.js';
import type { ProjectInspector } from '../../../common/project-resolution.js';

export async function initializePreambleStore(workspaceDir: string, retainExecutorReferences?: RetainExecutorReferences): Promise<PreambleStore> {
  const store = new PreambleStore(workspaceDir, retainExecutorReferences);
  await store.init();
  const installation = await store.installBundledPreambles(BUNDLED_PREAMBLES, new Date());
  if (installation.deferred > 0) {
    createLogger('preambles').warn(
      `${installation.deferred} bundled preamble(s) could not be installed because the catalog is full`,
    );
  }
  return store;
}

export function createPreambleService(
  store: PreambleStore,
  inspectProject: ProjectInspector,
  snippetShortNames?: Pick<SnippetShortNameCoordinator, 'runMutation'>,
): PreambleService {
  return new PreambleService({
    store,
    projectPaths: new PreambleProjectPathService(inspectProject),
    snippetShortNames,
  });
}

export async function initializePreambleService(workspaceDir: string, inspectProject: ProjectInspector): Promise<PreambleService> {
  return createPreambleService(await initializePreambleStore(workspaceDir), inspectProject);
}
