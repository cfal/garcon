import { DisplayStore } from './store.js';
import { appendDisplayFrame } from './extractor.js';
import { prepareBashFrame, pruneBashRevision } from './bash-revision.js';
import { DisplayQuery, displayCertificate } from './query.js';
import { hydrateBodyRead, planBodyRead } from './details.js';
import type { DisplayWorkerReply, DisplayWorkerRequest, DisplayWorkerTask } from './worker-protocol.js';
import { prepareSubagentFrame, pruneSubagentFrame } from './subagents.js';
import { querySubagents, queryUserRows } from './auxiliary-query.js';
import { decodeStoredLedgerRow } from '../ledger/codec.js';
import { ledgerRowToMessage } from '../ledger/presentation.js';
import { displayErrorCode } from './errors.js';

declare const self: Worker;

export function runDisplayWorker(role: 'builder' | 'reader'): void {
  const stores = new Map<string, DisplayStore>();
  const storeFor = (path: string) => {
    let store = stores.get(path);
    if (store) stores.delete(path);
    else store = new DisplayStore(path, role === 'reader');
    stores.set(path, store);
    while (stores.size > 8) {
      const first = stores.entries().next().value!;
      first[1].close(); stores.delete(first[0]);
    }
    return store;
  };
  const tailOrdinal = (store: DisplayStore) => {
    const tail = store.get<{ ordinal: number; failed_result: number }>('SELECT ordinal, failed_result FROM public_tail ORDER BY ordinal DESC LIMIT 1');
    return tail?.failed_result ? tail.ordinal : null;
  };
  function execute(task: DisplayWorkerTask): unknown {
    if (task.kind === 'close') { stores.get(task.path)?.close(); stores.delete(task.path); return null; }
    if (task.kind === 'hydrate') {
      if (role !== 'reader') throw new TypeError('Invalid worker role');
      return JSON.stringify(hydrateBodyRead(task.request, task.plan, task.rows));
    }
    if (task.kind === 'present-plan') {
      if (role !== 'reader' || task.rows.length !== 1) throw new TypeError('Invalid plan detail request');
      const message = ledgerRowToMessage(decodeStoredLedgerRow(task.rows[0]));
      if (message?.type !== 'exit-plan-mode-tool-use') throw new TypeError('Invalid plan body');
      return JSON.stringify({ ...task.identity, ordinal: task.rows[0].ordinal, message });
    }
    const store = storeFor(task.path);
    switch (task.kind) {
      case 'inspect': {
        if (role !== 'builder') throw new TypeError('Invalid worker role');
        store.initialize(task.chatId, task.viewId, task.serverInstanceId);
        const auxiliary = store.get<{ published: number; generation: number; building: number; cursor: number; relevant_through: number }>('SELECT * FROM auxiliary_control')!;
        return { manifest: store.manifest()!, tailOrdinal: tailOrdinal(store), revisions: store.all('SELECT * FROM bash_revision'),
          auxiliaryFrontier: auxiliary.published, auxiliaryBuilding: auxiliary.building, auxiliaryCursor: auxiliary.cursor,
          auxiliaryGeneration: auxiliary.generation, auxiliaryRelevantThrough: auxiliary.relevant_through };
      }
      case 'frame':
        if (role !== 'builder') throw new TypeError('Invalid worker role');
        return { frontier: appendDisplayFrame(store, task.rows, task.goal, task.serverInstanceId, task.previousTail), tailOrdinal: tailOrdinal(store) };
      case 'bash':
        if (role !== 'builder') throw new TypeError('Invalid worker role');
        return prepareBashFrame(store, task.revision, task.patterns, task.goal);
      case 'filter-failed':
        if (role !== 'builder') throw new TypeError('Invalid worker role');
        store.run('INSERT INTO bash_revision VALUES (?, 0, ?, ?) ON CONFLICT(revision) DO UPDATE SET status = excluded.status, failure_code = excluded.failure_code',
          task.revision, task.retry ? 'preparing' : 'failed', task.retry ? null : 'DISPLAY_FILTER_TIMEOUT');
        return null;
      case 'prune':
        if (role !== 'builder') throw new TypeError('Invalid worker role');
        return pruneBashRevision(store, task.revision);
      case 'auxiliary-frame':
        if (role !== 'builder') throw new TypeError('Invalid worker role');
        if (!pruneSubagentFrame(store)) return store.get<{ published: number }>('SELECT published FROM auxiliary_control')!.published;
        return prepareSubagentFrame(store, task.goal);
      case 'user-rows': return queryUserRows(store, task.request, task.identity);
      case 'subagents': return querySubagents(store, task.request, task.identity);
      case 'window': {
        return store.db.transaction(() => {
          const query = new DisplayQuery(store, task.request.profile, task.watermark, task.request.cuts, task.filteredBash);
          return query.window(task.request, displayCertificate(task.serverInstanceId, task.request, task.watermark), task.sourceHead, task.bashFrontier);
        })();
      }
      case 'members': return store.db.transaction(() => new DisplayQuery(store, task.request.profile, task.request.certificate.watermark, task.request.cuts, task.filteredBash).memberWindow(task.request))();
      case 'resolve': return store.db.transaction(() => new DisplayQuery(store, task.request.profile, task.watermark, task.request.cuts, task.filteredBash).resolve(task.ordinal, task.sourceHead))();
      case 'body-plan': return planBodyRead(store, task.request);
    }
  }
  self.onmessage = (event: MessageEvent<DisplayWorkerRequest>) => {
    const { id, task } = event.data;
    const started = performance.now();
    const before = 'path' in task ? stores.get(task.path)?.statements ?? 0 : 0;
    let reply: DisplayWorkerReply;
    try {
      const result = execute(task);
      const statements = 'path' in task ? Math.max(0, (stores.get(task.path)?.statements ?? 0) - before) : 0;
      reply = { id, ok: true, result, metrics: { durationMs: performance.now() - started, statements,
        responseBytes: typeof result === 'string' ? Buffer.byteLength(result, 'utf8') : 0 } };
    }
    catch (error) {
      const code = error instanceof TypeError ? 'DISPLAY_INVALID_REQUEST' : displayErrorCode(error);
      reply = { id, ok: false, code };
    }
    self.postMessage(reply);
  };
}
