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
  let permissionClaim = null;
  let currentLease = null;
  const notices = [];
  const currentView = () => options.currentView?.() ?? view;

  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  const createLease = () => {
    let closed = false;
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
    return {
      sink,
      get closed() { return closed; },
      close() { closed = true; activeRunId = null; },
    };
  };
  const ledger = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentView,
    currentRows: () => [...(options.rows ?? []), ...notices],
    currentSession: () => session,
    openProducer: (chatId) => {
      activeChatId = chatId;
      if (!currentLease || currentLease.closed) currentLease = createLease();
      return currentLease;
    },
    beginRun(chatId, runId) {
      if (!currentLease || currentLease.closed) throw new Error('sink closed');
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
    takePreparedInput: (...args) => typeof options.composition === 'function'
      ? options.composition(...args)
      : options.composition ?? null,
    appendNotice: (chatId, viewId, input) => {
      if (viewId !== currentView()?.viewId) throw new Error('stale view');
      options.appendNotice?.(chatId, viewId, input);
      const row = {
        kind: 'notice',
        viewId,
        ordinal: (options.rows?.length ?? 0) + notices.length + 1,
        at: '2026-08-12T00:00:00.000Z',
        message: input.content,
        detail: { title: input.title },
        providerMeta: null,
      };
      notices.push(row);
      emit({ type: 'rows', chatId, viewId, rows: [row] });
      return row;
    },
    conversationMessages: (chatId, excludedOrdinals) => options.conversationMessages
      ? options.conversationMessages(chatId, excludedOrdinals)
      : options.conversation ?? [],
    claimPermissionResolution: (control) => {
      permissionClaim = {
        chatId: control.chatId,
        viewId: view.viewId,
        runId: control.runId,
        permissionOccurrenceId: control.permissionOccurrenceId,
        claimId: 'claim-1',
        decision: options.permissionDecision ?? {
          permissionOccurrenceId: control.permissionOccurrenceId,
          respond: async () => undefined,
        },
      };
      options.onPermissionClaim?.(permissionClaim);
      return permissionClaim;
    },
    completePermissionResolution: (claim, decision) => {
      options.onPermissionResolved?.(claim, decision);
      permissionClaim = null;
    },
    abandonPermissionResolution: (claim) => {
      options.onPermissionAbandoned?.(claim);
      permissionClaim = null;
    },
  };
  return {
    ledger,
    adoption: { ensure: async () => view },
    get sink() { return currentLease?.sink ?? null; },
    notices,
    activeRunId: () => activeRunId,
  };
}
