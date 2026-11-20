import { AgentCallError, AgentIntegrationError, type AgentCliUpdates } from '@garcon/server-agent-interface';
import type { AgentCliUpdateStatus, AgentCliUpdatesResponse } from '../../../common/agent-cli-update.js';
import { DomainError } from '../../common/domain-error.js';
import { createLogger } from '../../common/log.js';

const logger = createLogger('cli-updates');

// Keeps a provider's failure text within what the browser contract accepts.
const MAX_FAILURE_MESSAGE_LENGTH = 500;
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

// Reports and starts native CLI updates for the agents on one executor. The
// executor owns the run; the controller only relays it.
export class AgentCliUpdateService {
  readonly #executors: CliUpdateExecutors;

  constructor(executors: CliUpdateExecutors) {
    this.#executors = executors;
  }

  async statuses(executorId: string, options: { readonly refresh: boolean; readonly signal?: AbortSignal }): Promise<AgentCliUpdatesResponse> {
    const timeout = AbortSignal.timeout(STATUS_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const sources = this.#executors.integrationsFor(executorId).list()
      .flatMap((integration) => integration.cliUpdates ? [{ agentId: integration.descriptor.id, updates: integration.cliUpdates }] : []);
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
      failures[agentId] = failureMessage(result.reason);
    });
    return { statuses, failures };
  }

  async start(executorId: string, agentId: string): Promise<AgentCliUpdateStatus> {
    const integration = this.#executors.integrationsFor(executorId).list()
      .find((candidate) => candidate.descriptor.id === agentId);
    if (!integration) throw new DomainError('UNSUPPORTED_AGENT', `Unknown agent: ${agentId}`, 400);
    if (!integration.cliUpdates) {
      throw new DomainError('OPERATION_UNSUPPORTED', `${agentId} does not report a native CLI to update.`, 400);
    }
    try {
      return await integration.cliUpdates.startUpdate();
    } catch (error) {
      if ((error instanceof AgentIntegrationError || error instanceof AgentCallError) && error.code === 'OPERATION_UNSUPPORTED') {
        throw new DomainError('OPERATION_UNSUPPORTED', error.message, 409);
      }
      throw error;
    }
  }
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}
