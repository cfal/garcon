import type { AgentUsageHistory } from '@garcon/server-agent-interface';
import type { UsageAgentSummary, UsageReadRequest, UsageSummary } from '../../../common/usage.js';

interface UsageSource {
  readonly descriptor: { readonly id: string };
  readonly usageHistory: AgentUsageHistory | null;
}

// ExecutorManager satisfies this; it throws for an unavailable executor.
export interface UsageExecutors {
  integrationsFor(executorId: string): { list(): readonly UsageSource[] };
}

export interface UsageReadOptions {
  readonly signal?: AbortSignal;
  // Bounds every integration read; a cold scan of a large history can outlast the HTTP idle timeout.
  readonly timeoutMs: number;
}

/**
 * Merges the usage each agent integration reads from its own native
 * transcripts on one executor. A failed integration read is reported in its
 * agent entry rather than failing the whole summary.
 */
export class UsageService {
  readonly #executors: UsageExecutors;

  constructor(executors: UsageExecutors) {
    this.#executors = executors;
  }

  async readSummary(executorId: string, request: UsageReadRequest, options: UsageReadOptions): Promise<UsageSummary> {
    const readers = this.#executors.integrationsFor(executorId).list()
      .flatMap((integration) => integration.usageHistory ? [{ integration, usage: integration.usageHistory }] : []);
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let pricingAsOf: string | null = null;
    const agents = await Promise.all(readers.map(async ({ integration, usage }) => {
      const summary = await readAgentUsage(integration, usage, request, signal, options.signal);
      if (summary.pricingAsOf && (pricingAsOf === null || summary.pricingAsOf > pricingAsOf)) pricingAsOf = summary.pricingAsOf;
      return summary.agent;
    }));
    return { executorId, ...request, readAt: new Date().toISOString(), pricingAsOf, agents };
  }
}

async function readAgentUsage(
  integration: UsageSource,
  usage: AgentUsageHistory,
  request: UsageReadRequest,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): Promise<{ readonly agent: UsageAgentSummary; readonly pricingAsOf: string | null }> {
  const agentId = integration.descriptor.id;
  try {
    const { pricingAsOf, ...report } = await usage.read({ ...request, signal });
    return { agent: { agentId, message: null, ...report }, pricingAsOf };
  } catch (error) {
    callerSignal?.throwIfAborted();
    return {
      agent: {
        agentId,
        status: 'failed',
        message: signal.aborted ? 'Reading usage took too long' : error instanceof Error ? error.message : 'Usage could not be read',
        buckets: [],
        scannedFiles: 0,
        unreadableFiles: 0,
        malformedRecords: 0,
        distinctSessions: 0,
      },
      pricingAsOf: null,
    };
  }
}
