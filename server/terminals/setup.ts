import type { ServerConfig } from '../config.js';
import { LocalWorkspaceTerminalService } from '../execution-node/local-workspace-terminals.js';
import type { WorkspaceTerminalService } from '../execution-nodes/workspace-terminals.js';
import { createLogger } from '../lib/log.js';
import { errorMessage } from '../lib/errors.js';
import { assertRealWithinProjectBase } from '../lib/path-boundary.js';
import { waitForShutdownPhasesWithTimeout } from '../lib/shutdown.js';
import { TerminalStreamHandler } from '../ws/terminal-stream.js';

const logger = createLogger('server');

export interface TerminalRuntime {
  readonly service: WorkspaceTerminalService;
  readonly stream: TerminalStreamHandler;
  shutdown(): Promise<boolean>;
}

export function initializeTerminalRuntime(
  config: Pick<ServerConfig, 'projectBasePath' | 'userShell'>,
  environment: Readonly<Record<string, string | undefined>>,
): TerminalRuntime {
  const service = new LocalWorkspaceTerminalService({
    projectBasePath: config.projectBasePath,
    assertProjectPathAllowed: assertRealWithinProjectBase,
    shell: config.userShell,
    environment,
  });
  return {
    service,
    stream: new TerminalStreamHandler(service),
    async shutdown() {
      const result = await waitForShutdownPhasesWithTimeout([() => service.shutdown()]);
      if (!result.completed) logger.warn('server: terminal cleanup timed out');
      for (const error of result.errors)
        logger.warn('server: terminal cleanup error:', errorMessage(error));
      return result.completed && result.errors.length === 0;
    },
  };
}
