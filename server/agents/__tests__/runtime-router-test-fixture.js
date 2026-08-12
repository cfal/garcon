export function createRuntimeTranscriptFixture(options = {}) {
  const view = {
    viewId: 'view-1',
    status: 'current',
    createdAt: '2026-08-12T00:00:00.000Z',
    contentStartOrdinal: 1,
  };
  const listeners = new Set();
  let activeRunId = null;
  let activeChatId = 'chat-1';
  let session = options.session ?? null;
  let closed = false;

  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  const sink = {
    publish(event) {
      if (closed) throw new Error('sink closed');
      if (event.type === 'session') {
        session = { kind: 'session', detail: event.session };
        emit({ type: 'session', chatId: activeChatId, viewId: view.viewId, row: session });
      } else if (event.type === 'run-ended' && event.runId === activeRunId) {
        activeRunId = null;
        emit({
          type: 'run-ended',
          chatId: activeChatId,
          viewId: view.viewId,
          runId: event.runId,
          row: { kind: 'run-ended', outcome: event.outcome, error: event.error },
        });
      }
    },
  };
  const lease = {
    sink,
    get closed() { return closed; },
    close() { closed = true; activeRunId = null; },
  };
  const ledger = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentView: () => view,
    currentRows: () => options.rows ?? [],
    currentSession: () => session,
    openProducer: (chatId) => {
      activeChatId = chatId;
      return lease;
    },
    beginRun(chatId, runId) {
      if (closed) throw new Error('sink closed');
      activeChatId = chatId;
      activeRunId = runId;
      return runId;
    },
    activeRunId: () => activeRunId,
    isRunActive: (_chatId, runId) => activeRunId !== null && (!runId || activeRunId === runId),
    activeChatIds: () => activeRunId === null ? [] : [activeChatId],
    interruptRun() {
      if (!activeRunId) return null;
      const runId = activeRunId;
      activeRunId = null;
      emit({
        type: 'run-ended',
        chatId: activeChatId,
        viewId: view.viewId,
        runId,
        row: { kind: 'run-ended', outcome: 'interrupted', origin: 'core' },
      });
      return { kind: 'run-ended', outcome: 'interrupted', origin: 'core' };
    },
    failRun(_chatId, runId, error) {
      if (activeRunId !== runId) return null;
      activeRunId = null;
      emit({
        type: 'run-ended',
        chatId: activeChatId,
        viewId: view.viewId,
        runId,
        row: { kind: 'run-ended', outcome: 'failed', origin: 'core', error },
      });
      return { kind: 'run-ended', outcome: 'failed', origin: 'core', error };
    },
    takePreparedInput: () => options.composition ?? null,
    conversationMessages: () => options.priorContext ?? [],
    appendPermissionResolution: (input) => input.lifecycle,
  };
  return {
    ledger,
    adoption: { ensure: async () => view },
    sink,
    activeRunId: () => activeRunId,
  };
}
