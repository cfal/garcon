import type { IChatRegistry } from '../chats/store.js';
import {
  createPreambleService,
  initializePreambleStore,
} from '../preambles/setup.js';
import type { PreambleService } from '../preambles/service.js';
import { SnippetProjectPathService, SnippetService } from './service.js';
import { SnippetShortNameCoordinator } from './short-name-coordinator.js';
import { SnippetStore } from './store.js';

export async function initializeSnippetAndPreambleServices(deps: {
  readonly workspaceDir: string;
  readonly chats: Pick<IChatRegistry, 'getChat'>;
}): Promise<{ snippets: SnippetService; preambles: PreambleService }> {
  const snippetStore = new SnippetStore(deps.workspaceDir);
  await snippetStore.init();
  const preambleStore = await initializePreambleStore(deps.workspaceDir);
  const snippetShortNames = new SnippetShortNameCoordinator({
    snippets: () => snippetStore.snapshot().snippets,
    preambles: () => preambleStore.snapshot().preambles,
  });
  snippetShortNames.assertCatalogsDoNotOverlap();
  return {
    preambles: createPreambleService(preambleStore, snippetShortNames),
    snippets: new SnippetService({
      store: snippetStore,
      preambles: preambleStore,
      snippetShortNames,
      chats: deps.chats,
      projectPaths: new SnippetProjectPathService(),
    }),
  };
}
