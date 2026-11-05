import type { WorkflowActivity, WorkflowAttempt, WorkflowAttemptInspection, WorkflowCatalogEntry, WorkflowDetail, WorkflowMutation } from '$shared/workflows';
import type { WorkflowBootstrap, WorkflowHttpMutationRequest } from '$shared/workflow-http';
import { parseWorkflowHttpMutation } from '$shared/workflow-http';
import { parseWorkflowPlan } from '$shared/workflow-validation';
import { workflowApi, type WorkflowApi } from '$lib/api/workflows.js';
import { ApiError, isIntermediaryResponse } from '$lib/api/client.js';
import { getSessionStorageItem, setSessionStorageItem, removeSessionStorageItem, SESSION_STORAGE_KEYS } from '$lib/utils/local-persistence.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';

export class WorkflowsController {
  bootstrap = $state.raw<WorkflowBootstrap | null>(null);
  catalog = $state.raw<readonly WorkflowCatalogEntry[]>([]);
  detail = $state.raw<WorkflowDetail | null>(null);
  attempts = $state.raw<readonly WorkflowAttempt[]>([]);
  activity = $state.raw<readonly WorkflowActivity[]>([]);
  selectedId = $state<string | null>(null);
  selectedTaskId = $state<string | null>(null);
  inspection = $state.raw<WorkflowAttemptInspection | null>(null);
  tab = $state<'list' | 'graph' | 'attention' | 'activity' | 'history'>('list');
  planView = $state<'active' | 'draft'>('active');
  loading = $state(false);
  pending = $state(false);
  error = $state<string | null>(null);
  recovery = $state.raw<WorkflowHttpMutationRequest | null>(null);
  dismissedRecoveryId = $state<string | null>(null);
  hasMore = $state(false);
  editor = $state<string | null>(null);
  editorWorkflowId = $state<string | null>(null);
  editorRevision = $state<number | null>(null);
  captainChatId = $state<string | null>(null);
  hasMoreAttempts = $state(false);
  hasMoreActivity = $state(false);
  loadingHistory = $state(false);
  #visible = false;
  #presentationVersion = 0;
  #disposed = false;
  #version = 0;
  #read: AbortController | null = null;
  #refresh: Promise<void> | null = null;
  #again = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #authority: string | null = null;
  #recoveryAuthority: string | null = null;
  #inspectionVersion = 0;
  #inspectionAttemptId: string | null = null;
  #scope = 0;
  #paged = new Set<'catalog' | 'attempts' | 'activity'>();

  constructor(private readonly api: WorkflowApi = workflowApi) {
    const saved = getSessionStorageItem(SESSION_STORAGE_KEYS.workflowOperation);
    if (saved) {
      try {
        const raw = JSON.parse(saved);
        if (typeof raw.authority !== 'string') throw new Error('Missing operation owner.');
        this.recovery = parseWorkflowHttpMutation(raw.request, raw.request.mutation.action);
        this.#recoveryAuthority = raw.authority;
      } catch { this.error = 'Saved workflow operation is invalid. No request was repeated.'; }
    }
    try {
      const archived: unknown = JSON.parse(getSessionStorageItem(SESSION_STORAGE_KEYS.workflowDismissedOperations) ?? '[]');
      const latest = Array.isArray(archived) ? archived.at(-1) : null;
      if (typeof latest?.operationId === 'string') this.dismissedRecoveryId = latest.operationId;
    } catch { /* Malformed local history never grants replay authority. */ }
  }

  setProjectState(_project: WorkspaceProjectState): void {}
  setAuthority(authority: string | null): void {
    if (this.#authority !== null && this.#authority !== authority) {
      this.#resetPaging();
      this.#cancelReads(); this.selectTask(null); this.detail = null; this.catalog = []; this.attempts = []; this.activity = []; this.editor = null;
    }
    this.#authority = authority;
  }
  setPresentationVisible(visible: boolean): void {
    if (this.#visible === visible) return;
    this.#visible = visible;
    this.#presentationVersion++;
    if (visible) void this.refresh();
    else this.#cancelReads();
  }
  invalidate(_id?: string): void {
    if (!this.#visible || this.#disposed) return;
    if (this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.refresh(); }, 100);
  }
  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.#cancelReads();
    this.#resetPaging();
    this.selectedId = id;
    this.selectTask(null);
    this.planView = 'active';
    this.detail = null; this.attempts = []; this.activity = [];
    void this.refresh();
  }
  selectTask(id: string | null): void {
    this.#inspectionVersion++;
    this.#inspectionAttemptId = null;
    this.inspection = null; this.selectedTaskId = id;
    const attempt = this.detail?.tasks.find(task => task.id === id)?.attempt;
    if (id && attempt) void this.#loadInspection(attempt.attemptId, id);
  }
  async inspectAttempt(attemptId: string): Promise<void> {
    await this.#loadInspection(attemptId, null);
  }
  async #loadInspection(attemptId: string, taskId: string | null): Promise<void> {
    if (!this.selectedId || this.#disposed) return;
    const scope = this.#scope;
    const inspectionVersion = ++this.#inspectionVersion;
    this.#inspectionAttemptId = attemptId;
    this.selectedTaskId = taskId;
    this.inspection = null;
    try {
      const inspection = await this.api.inspectAttempt(this.selectedId, attemptId);
      if (scope !== this.#scope || inspectionVersion !== this.#inspectionVersion || this.#disposed) return;
      if (taskId && this.detail?.tasks.find(task => task.id === taskId)?.attempt?.attemptId !== attemptId) return;
      this.inspection = inspection; this.selectedTaskId = taskId;
      this.attempts = this.attempts.map(attempt => attempt.attemptId === attemptId ? inspection.attempt : attempt);
    } catch (error) { if (scope === this.#scope && inspectionVersion === this.#inspectionVersion) this.error = message(error); }
  }
  async inspectGate(gateId: string) {
    if (!this.selectedId || this.#disposed || !this.#visible) return null;
    const scope = this.#scope;
    const presentation = this.#presentationVersion;
    const digest = this.detail?.gates.find(gate => gate.manifest.gateId === gateId)?.digest;
    try {
      const result = await this.api.inspectGate(this.selectedId, gateId);
      if (scope !== this.#scope || presentation !== this.#presentationVersion || !this.#visible || this.#disposed) return null;
      if (result.manifest.gateId !== gateId || result.digest !== digest
        || this.detail?.gates.find(gate => gate.manifest.gateId === gateId)?.digest !== digest) {
        throw new Error('Approval changed while loading its evidence.');
      }
      return result;
    } catch (error) {
      if (scope === this.#scope && presentation === this.#presentationVersion && !this.#disposed) this.error = message(error);
      return null;
    }
  }
  refresh(): Promise<void> {
    if (this.#disposed || !this.#visible) return Promise.resolve();
    if (this.#refresh) { this.#again = true; return this.#refresh; }
    this.#refresh = this.#load().finally(() => {
      this.#refresh = null;
      if (this.#again) { this.#again = false; void this.refresh(); }
    });
    return this.#refresh;
  }
  async #load(): Promise<void> {
    const version = ++this.#version;
    const selected = this.selectedId;
    const selectedTask = this.selectedTaskId;
    const selectedAttempt = this.#inspectionAttemptId;
    const catalogEnd = this.#paged.has('catalog') ? this.catalog.at(-1)?.id ?? null : null;
    let inspectionVersion = this.#inspectionVersion;
    const read = this.#read = new AbortController();
    this.loading = true;
    try {
      const bootstrap = await this.api.bootstrap(read.signal);
      const replaced = this.bootstrap !== null && this.bootstrap.storeId !== bootstrap.storeId;
      const catalog = await this.#readCatalog(replaced ? null : catalogEnd, read.signal);
      const detail = selected ? await this.api.detail(selected, read.signal) : null;
      const attempts = selected ? await this.api.attempts(selected, null, read.signal) : [];
      const activity = selected ? await this.api.activity(selected, undefined, read.signal) : [];
      if (version !== this.#version || this.#disposed || !this.#visible) return;
      if (replaced) {
        this.#resetPaging(); this.selectTask(null);
        this.editor = null;
      }
      const inspectedId = selectedTask ? detail?.tasks.find(task => task.id === selectedTask)?.attempt?.attemptId : selectedAttempt;
      let inspection: WorkflowAttemptInspection | null = null;
      if (!replaced && inspectionVersion === this.#inspectionVersion) {
        inspectionVersion = ++this.#inspectionVersion;
        inspection = selected && inspectedId ? await this.api.inspectAttempt(selected, inspectedId, read.signal) : null;
      }
      if (version !== this.#version || this.#disposed || !this.#visible) return;
      this.bootstrap = bootstrap;
      const catalogExtended = !replaced && this.#paged.has('catalog') && this.catalog.at(-1)?.id !== catalogEnd;
      this.catalog = catalogExtended ? mergePage(catalog.workflows, this.catalog, entry => entry.id)
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : catalog.workflows;
      this.detail = detail;
      this.attempts = this.#paged.has('attempts') ? mergePage(attempts, this.attempts, entry => entry.attemptId) : attempts;
      this.activity = this.#paged.has('activity') ? mergePage(activity, this.activity, entry => entry.sequence) : activity;
      if (!replaced && inspectionVersion === this.#inspectionVersion) {
        this.inspection = inspection; this.#inspectionAttemptId = inspectedId ?? null;
      }
      if (this.selectedTaskId && this.#inspectionAttemptId !== (detail?.tasks.find(task => task.id === this.selectedTaskId)?.attempt?.attemptId ?? null)) {
        this.selectTask(this.selectedTaskId);
      }
      if (this.inspection) this.attempts = this.attempts.map(attempt => attempt.attemptId === this.inspection!.attempt.attemptId ? this.inspection!.attempt : attempt);
      if (detail && !detail.active) this.planView = 'draft';
      if (!catalogExtended) this.hasMore = catalog.hasMore;
      if (!this.#paged.has('attempts')) this.hasMoreAttempts = attempts.length > 0;
      if (!this.#paged.has('activity')) this.hasMoreActivity = activity.length === 50;
      if (!this.recovery) this.error = null;
    } catch (error) {
      if (version === this.#version && !read.signal.aborted) this.error = message(error);
    } finally { if (version === this.#version) this.loading = false; }
  }
  async #readCatalog(lastId: string | null, signal: AbortSignal) {
    let page = await this.api.list(null, signal);
    const workflows = [...page.workflows];
    while (lastId && page.workflows.length === 50 && !page.workflows.some(workflow => workflow.id === lastId)) {
      signal.throwIfAborted();
      page = await this.api.list(workflows.at(-1)!.id, signal);
      workflows.push(...page.workflows);
    }
    return { workflows, hasMore: page.workflows.length === 50 };
  }
  async loadMore(): Promise<void> {
    if (this.#disposed) return;
    const scope = this.#scope;
    this.#paged.add('catalog');
    try {
      const page = await this.api.list(this.catalog.at(-1)?.id ?? null);
      if (scope !== this.#scope || this.#disposed) return;
      this.catalog = mergePage(this.catalog, page.workflows, entry => entry.id); this.hasMore = page.workflows.length === 50;
    } catch (error) { if (scope === this.#scope) this.error = message(error); }
  }
  async loadHistory(kind: 'attempts' | 'activity'): Promise<void> {
    if (!this.selectedId || this.loadingHistory || this.#disposed) return;
    const scope = this.#scope;
    const id = this.selectedId;
    this.#paged.add(kind);
    this.loadingHistory = true;
    try {
      if (kind === 'attempts') {
        const page = await this.api.attempts(id, this.attempts.at(-1)?.attemptId ?? null);
        if (scope !== this.#scope || this.#disposed) return;
        const known = new Set(this.attempts.map(attempt => attempt.attemptId));
        this.attempts = [...this.attempts, ...page.filter(attempt => !known.has(attempt.attemptId))];
        this.hasMoreAttempts = page.length > 0;
      } else {
        const page = await this.api.activity(id, this.activity.at(-1)?.sequence);
        if (scope !== this.#scope || this.#disposed) return;
        const known = new Set(this.activity.map(event => event.sequence));
        this.activity = [...this.activity, ...page.filter(event => !known.has(event.sequence))];
        this.hasMoreActivity = page.length === 50;
      }
    } catch (error) { if (scope === this.#scope) this.error = message(error); }
    finally { if (scope === this.#scope) this.loadingHistory = false; }
  }
  editDraft(): void {
    this.editorWorkflowId = this.detail?.workflow.id ?? null;
    this.editorRevision = this.detail?.draft.revision ?? null;
    this.captainChatId = this.detail?.workflow.captainChatId ?? null;
    this.editor = JSON.stringify(this.detail?.draft.plan ?? { title: '', goal: { kind: 'artifacts', taskIds: [] },
      policy: { allowRemoteWrites: false, concurrency: 2 }, tasks: [] }, null, 2);
  }
  newDraft(captainChatId: string | null = null): void { this.select(null); this.editDraft(); this.captainChatId = captainChatId; }
  async saveDraft(): Promise<void> {
    if (this.editor === null || this.pending) return;
    try {
      const plan = parseWorkflowPlan(JSON.parse(this.editor));
      const ok = await this.mutate(this.editorWorkflowId
        ? { action: 'plan', workflowId: this.editorWorkflowId, expectedPlanRevision: this.editorRevision!, plan }
        : { action: 'create', captainChatId: this.captainChatId, plan });
      if (ok) this.editor = null;
    } catch (error) { this.error = message(error); }
  }
  async mutate(mutation: WorkflowMutation): Promise<boolean> {
    if (!this.bootstrap || this.pending || this.recovery || this.#disposed || !this.#authority) return false;
    const request: WorkflowHttpMutationRequest = { expectedStoreId: this.bootstrap.storeId, operationId: crypto.randomUUID(), mutation };
    const encoded = JSON.stringify({ authority: this.#authority, request });
    setSessionStorageItem(SESSION_STORAGE_KEYS.workflowOperation, encoded);
    if (getSessionStorageItem(SESSION_STORAGE_KEYS.workflowOperation) !== encoded) {
      this.error = 'Browser recovery storage is unavailable. Nothing was submitted.'; return false;
    }
    this.recovery = request;
    this.#recoveryAuthority = this.#authority;
    return this.#send(request);
  }
  async recover(): Promise<void> {
    if (!this.recovery || this.pending || !this.bootstrap || this.#disposed) return;
    if (!this.#authority || this.#authority !== this.#recoveryAuthority) {
      this.error = 'Saved operation belongs to another browser principal. It will not be repeated.'; return;
    }
    if (this.recovery.expectedStoreId !== this.bootstrap.storeId) {
      this.error = 'Saved operation belongs to different workflow storage. It will not be repeated.'; return;
    }
    this.pending = true;
    const authority = this.#authority;
    try {
      const outcome = await this.api.operation(this.recovery.operationId);
      if (this.#disposed || this.#authority !== authority) return;
      if (outcome.kind === 'not-found') { this.pending = false; await this.#send(this.recovery); return; }
      this.#clearRecovery();
      if (outcome.kind === 'completed') this.select(outcome.result.workflowId);
      else this.error = 'Operation completed; its receipt expired. It was not repeated.';
      await this.refresh();
    } catch (error) { this.error = message(error); }
    finally { this.pending = false; }
  }
  dismissRecovery(): void {
    if (!this.recovery || this.pending) return;
    const request = this.recovery;
    try {
      const key = SESSION_STORAGE_KEYS.workflowDismissedOperations;
      const previous: unknown = JSON.parse(getSessionStorageItem(key) ?? '[]');
      const archived = Array.isArray(previous) ? previous.slice(-7) : [];
      const encoded = JSON.stringify([...archived, { operationId: request.operationId, expectedStoreId: request.expectedStoreId,
        authority: this.#recoveryAuthority, action: request.mutation.action,
        workflowId: 'workflowId' in request.mutation ? request.mutation.workflowId : null, dismissedAt: new Date().toISOString() }]);
      setSessionStorageItem(key, encoded);
      if (getSessionStorageItem(key) !== encoded) throw new Error('Recovery history could not be retained.');
      this.#clearRecovery();
      this.dismissedRecoveryId = request.operationId;
      this.error = `Local recovery dismissed for ${request.operationId}. Its outcome remains unconfirmed; no server action was canceled or repeated.`;
    } catch (error) { this.error = message(error); }
  }
  async #send(request: WorkflowHttpMutationRequest): Promise<boolean> {
    this.pending = true; this.error = null;
    const authority = this.#authority;
    try {
      const result = await this.api.mutate(request);
      if (this.#disposed || this.#authority !== authority) return false;
      this.#clearRecovery();
      if (request.mutation.action === 'activate') this.planView = 'active';
      if (request.mutation.action === 'archive') this.select(null);
      else this.select(result.workflowId);
      await this.refresh();
      return true;
    } catch (error) {
      if (this.#disposed || this.#authority !== authority) return false;
      if (error instanceof ApiError && !isIntermediaryResponse(error) && error.errorCode !== 'WORKFLOW_UNAVAILABLE') this.#clearRecovery();
      this.error = message(error);
      return false;
    } finally { this.pending = false; }
  }
  #clearRecovery(): void { this.recovery = null; this.#recoveryAuthority = null; removeSessionStorageItem(SESSION_STORAGE_KEYS.workflowOperation); }
  #resetPaging(): void {
    this.#scope++; this.#paged.clear(); this.loadingHistory = false;
    this.hasMore = false; this.hasMoreAttempts = false; this.hasMoreActivity = false;
  }
  #cancelReads(): void {
    this.#version++; this.#read?.abort(); this.loading = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
  dispose(): void { this.#disposed = true; this.#resetPaging(); this.#cancelReads(); }
}
function mergePage<T>(fresh: readonly T[], previous: readonly T[], key: (entry: T) => string | number): T[] {
  const known = new Set(fresh.map(key));
  return [...fresh, ...previous.filter(entry => !known.has(key(entry)))];
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
