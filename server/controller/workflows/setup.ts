import { createLogger } from '../../common/log.js';
import type { WorkflowServiceOptions } from './contracts.js';
import { workflowUnavailable } from './errors.js';
import { recoverWorkflowAttempts, suspendWorkflowAdmission } from './recovery.js';
import { WorkflowService } from './service.js';
import { inspectWorkflowProviderReferences, WorkflowStore } from './store.js';

const logger = createLogger('workflows:lifecycle');

export interface WorkflowEngineLifecycle {
  start(): void;
  pauseAdmission(): void;
  refreshControl(workflowId: string): void;
  stopRunning(workflowId: string): void;
  wake(workflowId?: string): void;
  beginShutdown(): void;
  waitForSettlements(): Promise<void>;
  dispose(): void;
}

export interface WorkflowRuntimeDependencies {
  readonly storageInitialized: () => boolean;
  readonly markStorageInitialized: () => Promise<void>;
  readonly createEngine: (store: WorkflowStore, onFailure: (error: unknown) => void) => WorkflowEngineLifecycle;
  readonly onInvalidated: NonNullable<WorkflowServiceOptions['onInvalidated']>;
  readonly now?: () => string;
}

export function createWorkflowProviderReferences(workspaceDir: string, initialized: () => boolean) {
  return {
    referencesApiProvider(id: string): boolean {
      // Re-inspection keeps missing, replaced, or newly initialized storage conservative.
      try { return inspectWorkflowProviderReferences(workspaceDir, initialized())?.has(id) ?? true; }
      catch { return true; }
    },
  };
}

export class WorkflowRuntime {
  readonly #references;
  #store: WorkflowStore | null = null;
  #service: WorkflowService | null = null;
  #engine: WorkflowEngineLifecycle | null = null;
  #opening: Promise<void> | null = null;
  #closing: Promise<void> | null = null;
  #failureCleanup: Promise<void> | null = null;
  #engineDisposed = false;
  #enabled = false;
  #suspensionPending = false;
  #failed = false;
  #shutdown = false;

  constructor(private readonly workspaceDir: string, private readonly deps: WorkflowRuntimeDependencies) {
    this.#references = createWorkflowProviderReferences(workspaceDir, deps.storageInitialized);
  }

  get service(): WorkflowService {
    if (!this.#service || this.#failed || this.#shutdown) throw workflowUnavailable();
    return this.#service;
  }

  referencesApiProvider(id: string): boolean { return this.#references.referencesApiProvider(id); }

  enable(): Promise<void> {
    if (this.#failed || this.#shutdown) return Promise.reject(workflowUnavailable());
    this.#enabled = true;
    if (this.#opening) return this.#opening;
    if (this.#engine) {
      try { this.#engine.start(); return Promise.resolve(); }
      catch (error) { this.#fail(error); return Promise.reject(workflowUnavailable()); }
    }
    this.#opening = this.#open().catch(error => {
      this.#fail(error);
      throw workflowUnavailable();
    }).finally(() => { this.#opening = null; });
    return this.#opening;
  }

  // Settings serializes toggles and awaits durable suspension before persisting a disable.
  async disable(): Promise<void> {
    if (this.#failed || this.#shutdown || !this.#service && !this.#opening && this.deps.storageInitialized()) throw workflowUnavailable();
    const wasEnabled = this.#enabled;
    this.#enabled = false;
    // Suspension must survive a failing engine hook or a subsequent restart.
    if (wasEnabled && this.#service && !this.#failed && !this.#shutdown) {
      try { suspendWorkflowAdmission(this.#store!); }
      catch (error) { this.#fail(error); throw workflowUnavailable(); }
    } else if (wasEnabled && this.#opening) this.#suspensionPending = true;
    try { this.#engine?.pauseAdmission(); }
    catch (error) { this.#fail(error); }
    if (this.#opening) {
      await this.#opening;
      if (this.#suspensionPending) throw workflowUnavailable();
    }
    if (this.#enabled) throw workflowUnavailable();
  }

  beginShutdown(): void {
    if (this.#shutdown) return;
    this.#shutdown = true;
    this.#enabled = false;
    try { this.#engine?.beginShutdown(); }
    catch (error) { this.#fail(error); }
  }

  close(drainMs = 1000): Promise<void> {
    if (this.#closing) return this.#closing;
    this.beginShutdown();
    this.#closing = this.#close(drainMs);
    return this.#closing;
  }

  async #open(): Promise<void> {
    if (this.deps.storageInitialized() && inspectWorkflowProviderReferences(this.workspaceDir, true) === null) throw workflowUnavailable();
    const store = this.#store = new WorkflowStore(this.workspaceDir);
    // No service or external effect is published until the initialized marker is durable.
    await this.deps.markStorageInitialized();
    if (this.#shutdown) return;
    await recoverWorkflowAttempts(store, this.deps.now ?? (() => new Date().toISOString()));
    if (this.#shutdown) return;
    if (this.#suspensionPending || !this.#enabled) suspendWorkflowAdmission(store);
    this.#suspensionPending = false;
    this.#engine = this.deps.createEngine(store, error => this.#fail(error));
    if (this.#failed || this.#shutdown) {
      this.#engine.beginShutdown();
      throw workflowUnavailable();
    }
    this.#service = new WorkflowService(store, {
      enabled: () => this.#enabled && !this.#failed && !this.#shutdown,
      now: this.deps.now,
      onControl: (id, action) => {
        try {
          if (action === 'stop' || action === 'cancel') this.#engine!.stopRunning(id);
          else if (action === 'activate') this.#engine!.refreshControl(id);
        } catch (error) { this.#fail(error); }
      },
      onInvalidated: (id, revision) => {
        try { if (!this.#failed) this.#engine!.wake(id); }
        catch (error) { this.#fail(error); }
        this.deps.onInvalidated(id, revision);
      },
    });
    if (this.#enabled) this.#engine.start();
  }

  async #close(drainMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = (async () => {
      await this.#opening;
      await this.#engine?.waitForSettlements();
    })().catch(error => { logger.warn('Workflow drain retained unresolved work.', { error }); });
    try {
      await Promise.race([drain, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, Math.min(drainMs, 5000))); })]);
    } finally {
      if (timer) clearTimeout(timer);
      try { this.#disposeEngine(); }
      catch (error) { logger.warn('Workflow listener disposal failed.', { error }); }
      this.#store?.close();
      await this.#failureCleanup;
    }
  }

  #disposeEngine(): void {
    if (!this.#engine || this.#engineDisposed) return;
    this.#engineDisposed = true;
    this.#engine.dispose();
  }

  #fail(error: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#enabled = false;
    let shutdownFailure: unknown;
    try { this.#engine?.beginShutdown(); }
    catch (failure) { shutdownFailure = failure; }
    // Core revocation callbacks only fence memory; cleanup and logging yield to the core continuation.
    this.#failureCleanup = new Promise(resolve => setImmediate(() => {
      try { this.#disposeEngine(); }
      catch (failure) { logger.warn('Workflow listener disposal failed.', { failure }); }
      this.#store?.close();
      if (shutdownFailure) logger.warn('Workflow shutdown fencing failed.', { failure: shutdownFailure });
      logger.warn('Workflow storage or lifecycle failed; ordinary chats remain available.', { error });
      resolve();
    }));
  }
}
