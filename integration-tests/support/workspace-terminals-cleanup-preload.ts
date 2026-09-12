import { mock } from 'bun:test';
import {
  LocalWorkspaceTerminalService,
  type TerminalPty,
} from '../../server/execution-node/local-workspace-terminals.js';
import { WorkspaceTerminalError } from '../../server/execution-nodes/workspace-terminals.js';
import { withJsonBody } from '../../server/lib/json-route.js';
import createTerminalRoutes from '../../server/routes/terminals.js';
import { isRecord } from '../../common/json.js';

const buildTerminalRoutes = createTerminalRoutes;
const gateUrl = process.env.GARCON_TEST_TERMINAL_GATE;
if (!gateUrl) throw new Error('Terminal cleanup fixture requires a spawn barrier');
let owner: LocalWorkspaceTerminalService;
let now = 0;
let creations = 0;
let spawned = 0;
let kills = 0;
let refuseKill = true;

class ControlledTerminalService extends LocalWorkspaceTerminalService {
  constructor(options: ConstructorParameters<typeof LocalWorkspaceTerminalService>[0]) {
    super({
      ...options,
      now: () => now,
      createResultTtlMs: 1,
      requestResultsTotal: 1,
      spawnPty: async () => {
        spawned++;
        const response = await fetch(gateUrl!, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error('Terminal spawn barrier failed');
        now = 1000;
        return {
          write() {},
          resize() {},
          kill() {
            kills++;
            if (refuseKill) throw new Error('Synthetic PTY cleanup failure');
          },
          onData() {
            return { dispose() {} };
          },
          onExit() {
            return { dispose() {} };
          },
        } satisfies TerminalPty;
      },
    });
    owner = this;
  }

  override create(...[principal, request]: Parameters<LocalWorkspaceTerminalService['create']>) {
    return super.create({ ...principal, expiresAtMs: creations++ === 0 ? 1 : null }, request);
  }
}

mock.module('../../server/execution-node/local-workspace-terminals.js', () => ({
  LocalWorkspaceTerminalService: ControlledTerminalService,
}));
mock.module('../../server/routes/terminals.js', () => ({
  default(...args: Parameters<typeof buildTerminalRoutes>) {
    return {
      ...buildTerminalRoutes(...args),
      '/api/v1/test/terminal-cleanup': {
        POST: withJsonBody(async (body: unknown) => {
          if (!isRecord(body) || typeof body.refuseKill !== 'boolean')
            throw new Error('Invalid terminal cleanup fixture command');
          refuseKill = body.refuseKill;
          try {
            await owner.shutdown();
            return Response.json({ spawned, kills, error: null });
          } catch (error) {
            if (!(error instanceof WorkspaceTerminalError)) throw error;
            return Response.json({ spawned, kills, error: error.code });
          }
        }),
      },
    };
  },
}));
