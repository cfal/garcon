import {
  AgentCallError, type AgentIntegration, type AgentImportedTranscriptRow,
} from '@garcon/server-agent-interface';
import { AgentResourceTable } from '@garcon/server-agent-common/execution/resource-table';
import type { ExecutorRpcRequest, HistoryReaderRef } from '../transport/rpc-protocol.js';
import { historyPages } from '../transport/history-pages.js';

type HistoryRequest = Extract<ExecutorRpcRequest, { method: 'history.open' | 'history.next' | 'history.close' }>;

interface HistoryReader {
  readonly closeSource: () => Promise<unknown>;
  readonly iterator: AsyncIterator<readonly AgentImportedTranscriptRow[]>;
  readonly controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  requestedPages: number;
  tail: Promise<unknown>;
  started: boolean;
  closing: Promise<unknown> | null;
}

// Reader ownership ends with one bulk session, independently of primary runtime service.
export class HistoryRpcServer {
  readonly #tables = new Map<string, AgentResourceTable<'history-reader', HistoryReader>>();
  readonly #resources = new Set<HistoryReader>();
  #closed = false;

  constructor(private readonly integrations: ReadonlyMap<string, AgentIntegration>) {}

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const resource of this.#resources) void this.#close(resource).catch(() => undefined);
    this.#resources.clear();
    for (const table of this.#tables.values()) table.clear();
    this.#tables.clear();
  }

  async handle(call: HistoryRequest, signal: AbortSignal): Promise<unknown> {
    this.#assertOpen(signal);
    const integration = this.integrations.get(call.integrationId);
    if (!integration) throw new AgentCallError('rejected', 'Unknown history integration', 'OPERATION_UNSUPPORTED');
    let table = this.#tables.get(call.integrationId);
    if (!table) {
      table = new AgentResourceTable(integration.producers.scope, 'history-reader', 16);
      this.#tables.set(call.integrationId, table);
    }
    switch (call.method) {
      case 'history.open': {
        const { source: sourceKind, request } = call.request;
        if (sourceKind !== 'nativeHistoryImport' && sourceKind !== 'legacyHistoryImport') {
          throw new AgentCallError('rejected', 'Unknown history source');
        }
        if (sourceKind === 'nativeHistoryImport') {
          const running = await integration.execution.runningSessions({ signal });
          this.#assertOpen(signal);
          if (running.some((session) => session.agentSessionId === request.chat.agentSessionId)) {
            throw new AgentCallError('rejected', 'The turn is still running on the executor. Reload from native history after it finishes.', 'SESSION_BUSY');
          }
        }
        const history = integration[sourceKind];
        if (!history) throw new AgentCallError('rejected', 'History capability unavailable', 'OPERATION_UNSUPPORTED');
        const controller = new AbortController();
        const source = history.load({ ...request, signal: controller.signal })[Symbol.asyncIterator]();
        let returning: Promise<IteratorResult<readonly AgentImportedTranscriptRow[]>> | null = null;
        const closeSource = () => returning ??= Promise.resolve().then(() => source.return ? source.return() : { done: true as const, value: undefined });
        const assertCurrent = () => this.#assertOpen(controller.signal);
        const iterator = historyPages({ [Symbol.asyncIterator]: () => ({
          async next() {
            assertCurrent();
            const batch = await source.next();
            assertCurrent();
            return batch;
          },
          return: closeSource,
        }) });
        const resource: HistoryReader = { closeSource, iterator, controller, timer: null, requestedPages: 0,
          tail: Promise.resolve(), started: false, closing: null };
        let ref: HistoryReaderRef;
        try {
          this.#assertOpen(signal);
          ref = table.add(resource);
        } catch (error) { await this.#close(resource); throw error; }
        resource.timer = setTimeout(() => {
          table.delete(ref);
          void this.#close(resource).catch(() => undefined);
        }, 120_000);
        resource.timer.unref();
        this.#resources.add(resource);
        return ref;
      }
      case 'history.next': {
        const resource = table.get(call.request.reader);
        this.#assertOpen(signal, resource);
        if (call.request.page !== resource.requestedPages) throw new AgentCallError('rejected', 'History pages must be requested in order');
        resource.requestedPages++;
        resource.timer?.refresh();
        const page = resource.tail.then(async () => {
          this.#assertOpen(signal, resource);
          resource.started = true;
          const result = await resource.iterator.next();
          this.#assertOpen(signal, resource);
          return { done: result.done === true, rows: result.value ?? [] };
        });
        resource.tail = page.catch(() => undefined);
        const abort = () => { void this.#close(resource).catch(() => undefined); };
        signal.addEventListener('abort', abort, { once: true });
        try { return await page; }
        finally { signal.removeEventListener('abort', abort); }
      }
      case 'history.close': return this.#close(table.take(call.request));
    }
  }

  #assertOpen(signal: AbortSignal, resource?: HistoryReader): void {
    if (this.#closed || signal.aborted || resource?.controller.signal.aborted) {
      throw new AgentCallError('not-dispatched', 'History reader session retired or request cancelled', 'STALE_RESOURCE');
    }
  }

  #close(resource: HistoryReader): Promise<unknown> {
    if (resource.closing) return resource.closing;
    this.#resources.delete(resource);
    for (const table of this.#tables.values()) table.removeWhere((entry) => entry === resource);
    if (resource.timer) clearTimeout(resource.timer);
    resource.controller.abort();
    // An unstarted or failed paging iterator need not return its underlying source.
    resource.closing = Promise.resolve().then(async () => {
      try { if (resource.started) await resource.iterator.return?.(); }
      finally { await resource.closeSource(); }
    });
    return resource.closing;
  }
}
