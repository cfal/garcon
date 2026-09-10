import { mock } from 'bun:test';
import { LocalWorkspaceFileService } from '../../server/execution-node/local-workspace-files.js';
import { listDirectoryStrict } from '../../server/files/directory-listing.js';
import createFilesRoutes from '../../server/routes/files.js';

const gateUrl = process.env.GARCON_TEST_FILE_READ_GATE;
if (!gateUrl) throw new Error('Workspace file cancellation fixture requires its barrier');
const buildFilesRoutes = createFilesRoutes;

async function reachGate(stage: string, detail: Record<string, unknown> = {}): Promise<void> {
  const response = await fetch(new URL(stage, gateUrl), {
    method: 'POST', body: JSON.stringify(detail), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('Synthetic file-read barrier failed');
}

class GatedWorkspaceFileService extends LocalWorkspaceFileService {
  constructor(options: ConstructorParameters<typeof LocalWorkspaceFileService>[0]) {
    super({
      ...options,
      async listTreeDirectory(directory, signal) {
        const entries = await listDirectoryStrict(directory, signal);
        let observation: Promise<void> | undefined;
        const onAbort = () => {
          observation = reachGate('aborted');
          void observation.catch(() => {});
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          await reachGate('held');
          return entries;
        } finally {
          signal.removeEventListener('abort', onAbort);
          await observation;
        }
      },
    });
  }
}

mock.module('../../server/execution-node/local-workspace-files.js', () => ({
  LocalWorkspaceFileService: GatedWorkspaceFileService,
}));
mock.module('../../server/routes/files.js', () => ({
  default(...args: Parameters<typeof createFilesRoutes>) {
    const routes = buildFilesRoutes(...args);
    const getTree = routes['/api/v1/files/tree'].GET;
    routes['/api/v1/files/tree'].GET = async (...request) => {
      const response = await getTree(...request);
      await reachGate('responded', { status: response.status });
      return response;
    };
    return routes;
  },
}));
