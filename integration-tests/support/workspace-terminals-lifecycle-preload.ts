import { mock, spyOn } from 'bun:test';
import { appendFileSync, promises as fs } from 'node:fs';
import { LocalWorkspaceTerminalService } from '../../server/execution-node/local-workspace-terminals.js';
import createTerminalRoutes from '../../server/routes/terminals.js';

const buildTerminalRoutes = createTerminalRoutes;

const gateUrl = process.env.GARCON_TEST_TERMINAL_GATE;
const directory = process.env.GARCON_TEST_TERMINAL_DIRECTORY;
const observationPath = process.env.GARCON_TEST_TERMINAL_OBSERVATION;
if (!gateUrl || !directory || !observationPath)
  throw new Error('Terminal lifecycle fixture requires its barrier and observation paths');
const observationFile = observationPath;
const scenario = process.env.GARCON_TEST_TERMINAL_SCENARIO;
if (scenario !== 'shutdown' && scenario !== 'disconnect')
  throw new Error('Terminal lifecycle fixture requires an explicit scenario');

async function reachGate(stage: string): Promise<void> {
  const response = await fetch(new URL(stage, gateUrl), {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Terminal lifecycle barrier failed');
}

function record(event: string): void {
  appendFileSync(observationFile, event + '\n');
}

const originalAccess = fs.access;
spyOn(fs, 'access').mockImplementation(async (...args: Parameters<typeof fs.access>) => {
  await originalAccess(...args);
  if (args[0] === directory) await reachGate('resolving');
});

class GatedTerminalService extends LocalWorkspaceTerminalService {
  readonly #pending = new Set<Promise<unknown>>();

  constructor(...args: ConstructorParameters<typeof LocalWorkspaceTerminalService>) {
    super({
      ...args[0],
      ...(scenario === 'shutdown'
        ? {
            spawnPty: () => {
              record('spawned');
              throw new Error('Synthetic terminal must never spawn after shutdown');
            },
          }
        : {}),
    });
  }

  override create(...args: Parameters<LocalWorkspaceTerminalService['create']>) {
    const operation = super.create(...args);
    this.#pending.add(operation);
    void operation.then(
      () => {
        record('created');
        this.#pending.delete(operation);
      },
      () => {
        record('rejected');
        this.#pending.delete(operation);
      },
    );
    return operation;
  }

  override shutdown(): Promise<void> {
    const stopping = super.shutdown();
    const observed = (async () => {
      await stopping;
      await Promise.allSettled([...this.#pending]);
      record('settled');
    })();
    return Promise.all([observed, reachGate('shutdown-entered')]).then(() => undefined);
  }
}

mock.module('../../server/execution-node/local-workspace-terminals.js', () => ({
  LocalWorkspaceTerminalService: GatedTerminalService,
}));

if (scenario === 'disconnect') {
  mock.module('../../server/routes/terminals.js', () => ({
    default: (...args: Parameters<typeof buildTerminalRoutes>) => {
      const routes = buildTerminalRoutes(...args);
      const post = routes['/api/v1/terminals'].POST;
      routes['/api/v1/terminals'].POST = async (...routeArgs) => {
        const request = routeArgs[0];
        const aborted = () => {
          void reachGate('disconnected').catch(() => record('disconnect-barrier-failed'));
        };
        request.signal.addEventListener('abort', aborted, { once: true });
        try {
          return await post(...routeArgs);
        } finally {
          request.signal.removeEventListener('abort', aborted);
        }
      };
      return routes;
    },
  }));
}
