import type { AgentCliUpdates } from '@garcon/server-agent-interface';
import {
  AGENT_CLI_UPDATE_MESSAGE_MAX_CHARS,
  type AgentCliUpdateStatus,
  type AgentCliUpdatesResponse,
} from '../../../common/agent-cli-update.js';
import { DomainError } from '../../common/domain-error.js';
import { errorMessage } from '../../common/errors.js';
import { createLogger } from '../../common/log.js';

const logger = createLogger('cli-updates');

// A status check probes the CLI and may ask its installer for the latest release.
const STATUS_TIMEOUT_MS = 25_000;

interface CliUpdateSource {
  readonly descriptor: { readonly id: string };
  readonly cliUpdates: AgentCliUpdates | null;
}

// ExecutorManager satisfies this; it throws for an unavailable executor.
export interface CliUpdateExecutors {
  integrationsFor(executorId: string): { list(): readonly CliUpdateSource[] };
}

export interface CliUpdateStatusOptions {
  readonly refresh: boolean;
  // Limits the read to these agents, as polling a running update does.
  readonly agentIds?: readonly string[];
  readonly signal?: AbortSignal;
}

// Reports and starts native CLI updates for the agents on one executor. The
// executor owns each run; the controller only relays it. Refusals keep their
// integration error, which the HTTP layer reports as 422.
export class AgentCliUpdateService {
  readonly #executors: CliUpdateExecutors;

  constructor(executors: CliUpdateExecutors) {
    this.#executors = executors;
  }

  async statuses(executorId: string, options: CliUpdateStatusOptions): Promise<AgentCliUpdatesResponse> {
    const timeout = AbortSignal.timeout(STATUS_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const sources = this.#executors.integrationsFor(executorId).list().flatMap((integration) => (
      integration.cliUpdates && (!options.agentIds || options.agentIds.includes(integration.descriptor.id))
        ? [{ agentId: integration.descriptor.id, updates: integration.cliUpdates }]
        : []
    ));
    const results = await Promise.allSettled(sources.map(({ updates }) => updates.status({ refresh: options.refresh, signal })));
    const statuses: Record<string, AgentCliUpdateStatus> = {};
    const failures: Record<string, string> = {};
    results.forEach((result, index) => {
      const agentId = sources[index]!.agentId;
      if (result.status === 'fulfilled') {
        statuses[agentId] = result.value;
        return;
      }
      options.signal?.throwIfAborted();
      logger.warn('CLI update status failed.', { agentId, executorId, error: String(result.reason) });
      failures[agentId] = errorMessage(result.reason).slice(0, AGENT_CLI_UPDATE_MESSAGE_MAX_CHARS);
    });
    return { statuses, failures };
  }

  async start(executorId: string, agentId: string): Promise<AgentCliUpdateStatus> {
    const integration = this.#executors.integrationsFor(executorId).list()
      .find((candidate) => candidate.descriptor.id === agentId);
    if (!integration) throw new DomainError('UNSUPPORTED_AGENT', `Unknown agent: ${agentId}`, 400);
    if (!integration.cliUpdates) {
      throw new DomainError('OPERATION_UNSUPPORTED', `${agentId} does not report a native CLI to update.`, 422);
    }
    return integration.cliUpdates.startUpdate();
  }
}
