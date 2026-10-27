import type { AgentUsageHistory } from '@garcon/server-agent-interface';
import { parseAgentUsageReport, type UsageAgentSummary, type UsageReadRequest, type UsageSummary } from '../../../common/usage.js';

// Keeps a provider's failure text within what the browser contract accepts.
const MAX_FAILURE_MESSAGE_LENGTH = 500;

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
 * transcripts on one executor. A failed or malformed integration read is
 * reported in its agent entry rather than failing the whole summary; Local
 * reports are validated like remote ones.
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
    const parsed = parseAgentUsageReport(await untilAborted(usage.read({ ...request, signal }), signal));
    if (!parsed) throw new Error('The agent returned an invalid usage report');
    const { pricingAsOf, ...report } = parsed;
    return { agent: { agentId, message: null, ...report }, pricingAsOf };
  } catch (error) {
    callerSignal?.throwIfAborted();
    const message = signal.aborted ? 'Reading usage took too long' : error instanceof Error ? error.message : 'Usage could not be read';
    return {
      agent: {
        agentId,
        status: 'failed',
        message: message.length > MAX_FAILURE_MESSAGE_LENGTH ? `${message.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 1)}…` : message,
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

// Stops waiting once the read is cancelled or times out, even if the integration has
// not yet observed its signal, so one slow provider cannot hold the whole summary.
function untilAborted<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    read.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    read.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}
