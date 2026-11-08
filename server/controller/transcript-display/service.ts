import { createHash } from 'node:crypto';
import { lstat, readdir, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { ensureLedgerChatDirectory, ensureLedgerRootDirectory } from '../ledger/directories.js';
import { transcriptViewId, type TranscriptWatermark } from '../ledger/contracts.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import type { TranscriptAdoptionService } from '../ledger/adoption.js';
import { StaleTranscriptViewError } from '../ledger/errors.js';
import { DomainError } from '../../common/domain-error.js';
import { DISPLAY_POLICY_REVISION } from '../../../common/transcript-display-policy.js';
import { bashRevisionInput, compileHiddenBashCommandPatterns } from '../../../common/transcript-display-matcher.js';
import { displayCutsKey, displayProfileKey, type BodyDependencyRequest, type CertifiedDisplayRequest, type DisplayUnavailable,
  type DisplayWindowRequest, type DisplayWindowResponse, type MemberWindowRequest } from '../../../common/transcript-display-contract.js';
import type { HiddenBashCommandPattern } from '../../../common/hidden-bash-command-patterns.js';
import { DisplayWorkerClient } from './worker-client.js';
import type { DisplayWorkerResults, DisplayWorkerTask } from './worker-protocol.js';
import { sourceFingerprint } from './store.js';
import type { AuxiliaryPreparing, DisplayAuxiliaryRequest } from '../../../common/transcript-display-auxiliary.js';
import { ChatPlanPresentationStore } from './plan-presentation.js';
import type { PlanPresentationRequest } from '../../../common/transcript-display-open.js';
import { displayErrorCode as errorCode, transientDisplayFailure } from './errors.js';
import { isErrorCode } from '../../../common/error-codes.js';

interface DisplayJob {
  chatId: string; viewId: string; path: string; frontier: number; goal: number;
  tailOrdinal: number | null; ready: boolean; failure: string | null; activeAt: number;
  bash: Map<string, { frontier: number; failure: string | null; pruning: boolean }>;
  auxiliaryFrontier: number; auxiliaryRequested: boolean; auxiliaryFailure: string | null;
  phase: 'structure' | 'bash' | 'auxiliary'; initialize: Promise<void>; fileIdentity: string | null;
}
interface Retirement { kind: 'maintenance' | 'eviction'; work: () => Promise<void>; promise: Promise<void>; failed: boolean }
export interface DisplayStatus {
  readonly chatId: string; readonly transcriptViewId: string; readonly policyRevision: number;
  readonly bashRevision: string; readonly preparedThrough: number; readonly structuralPreparedThrough: number;
  readonly auxiliaryRevision: number;
  readonly phase: 'preparing' | 'available' | 'failed'; readonly errorCode: string | null;
}
export interface TranscriptDisplayOptions {
  readonly workspaceDirectory: string;
  readonly serverInstanceId: string;
  readonly ledger: TranscriptLedgerService;
  readonly adoption: Pick<TranscriptAdoptionService, 'ensure'>;
  readonly hasChat: (chatId: string) => boolean;
  readonly patterns: () => readonly HiddenBashCommandPattern[];
  readonly onStatus?: (status: DisplayStatus) => void;
  readonly onPlanChanged?: (snapshot: import('../../../common/transcript-display-open.js').PlanPresentationSnapshot) => void;
  readonly diskBudget?: number;
  readonly freeSpaceReserve?: number;
  readonly onMaintenanceError?: (chatId: string, code: string) => void;
}

export class TranscriptDisplayService {
  readonly plans: ChatPlanPresentationStore;
  readonly #root: string;
  readonly #builder = new DisplayWorkerClient('builder');
  readonly #reader = new DisplayWorkerClient('reader');
  readonly #jobs = new Map<string, DisplayJob>();
  readonly #retries = new Map<string, { viewId: string; promise: Promise<void> }>();
  readonly #retirements = new Map<string, Retirement>();
  readonly #files = new Map<string, { bytes: number; usedAt: number }>();
  readonly #abort = new AbortController();
  readonly #unsubscribe: () => void;
  #running: Promise<void> | null = null;
  #revision = '';
  #patterns: readonly HiddenBashCommandPattern[] = [];
  #visibleFrames = 0;
  #wakePending = false;
  #frames = { count: 0, rows: 0, estimatedBytes: 0, evictions: 0 };
  readonly #statusTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(readonly options: TranscriptDisplayOptions) {
    this.plans = new ChatPlanPresentationStore(options.serverInstanceId, options.onPlanChanged);
    this.#root = path.resolve(options.workspaceDirectory, 'transcript-display');
    this.settingsChanged();
    this.#unsubscribe = options.ledger.subscribe(event => {
      if (!options.hasChat(event.chatId)) return;
      this.plans.apply(event);
      if (event.type === 'view-replaced') { this.forget(event.chatId); return; }
      const job = this.#jobs.get(event.chatId);
      if (!job || job.viewId !== event.viewId) return;
      job.goal = Math.max(job.goal, event.type === 'rows' ? event.rows.at(-1)!.ordinal : event.row.ordinal);
      this.#pump();
    });
  }

  get bashRevision(): string { return this.#revision; }
  get serverInstanceId(): string { return this.options.serverInstanceId; }

  currentHead(chatId: string, expectedViewId: string): TranscriptWatermark {
    this.#exists(chatId);
    const head = this.options.ledger.highWatermark(chatId);
    if (head.viewId !== expectedViewId) throw new StaleTranscriptViewError(chatId, expectedViewId, head.viewId);
    return head;
  }

  async planBody(request: PlanPresentationRequest, signal?: AbortSignal): Promise<string> {
    const ordinal = this.plans.requirePending(request), head = this.currentHead(request.chatId, request.transcriptViewId);
    const result = await this.options.ledger.withStoredRowsByOrdinals(request.chatId, head, [ordinal],
      rows => this.#reader.request({ kind: 'present-plan', rows, identity: { serverInstanceId: this.serverInstanceId,
        chatId: request.chatId, transcriptViewId: request.transcriptViewId } }, signal));
    this.currentHead(request.chatId, request.transcriptViewId); this.plans.requirePending(request);
    return result;
  }

  async initialize(): Promise<void> {
    if (ensureLedgerRootDirectory(this.#root) !== this.#root) throw new Error('Transcript display root changed');
    const recent: { chatId: string; mtime: number }[] = [];
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (this.#abort.signal.aborted) return;
      if (!/^[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      if (this.#jobs.has(entry.name)) continue;
      const retirement = this.#scheduleRetirement(entry.name, 'maintenance', async () => {
        const directory = path.join(this.#root, entry.name);
        if (!this.options.hasChat(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
          await rm(directory, { recursive: true, force: true }); return;
        }
        const view = this.options.ledger.existingCurrentView(entry.name);
        if (!view) { await rm(directory, { recursive: true, force: true }); return; }
        const filename = displayFilename(view.viewId);
        for (const file of await readdir(directory, { withFileTypes: true })) {
          if (![filename, `${filename}-wal`, `${filename}-shm`].includes(file.name) || !file.isFile() || file.isSymbolicLink()) {
            await rm(path.join(directory, file.name), { recursive: true, force: true });
          }
          await Bun.sleep(0);
        }
        const filePath = path.join(directory, filename), usedAt = (await lstat(directory)).mtimeMs;
        const bytes = await displayFileBytes(filePath);
        if (this.#retirements.get(entry.name) !== retirement) return;
        this.#files.set(entry.name, { bytes, usedAt });
        recent.push({ chatId: entry.name, mtime: usedAt });
        recent.sort((a, b) => b.mtime - a.mtime); if (recent.length > 8) recent.pop();
      });
      await retirement.promise.catch(error => this.options.onMaintenanceError?.(entry.name, errorCode(error)));
      await Bun.sleep(0);
    }
    for (const { chatId } of recent) {
      if (this.#abort.signal.aborted || !this.options.hasChat(chatId)) continue;
      try {
        const view = this.options.ledger.existingCurrentView(chatId);
        if (view) this.#admit(chatId, view.viewId, false);
      } catch (error) { this.options.onMaintenanceError?.(chatId, errorCode(error)); }
      await Bun.sleep(0);
    }
  }

  settingsChanged(): void {
    const patterns = this.options.patterns();
    const revision = createHash('sha256').update(bashRevisionInput(patterns)).digest('hex');
    if (revision === this.#revision) return;
    this.#revision = revision;
    this.#patterns = compileHiddenBashCommandPatterns(patterns) ? patterns.map(pattern => ({ ...pattern })) : [];
    for (const job of this.#jobs.values()) this.#notify(job);
    this.#pump();
  }

  async open(chatId: string, expectedView?: string, signal?: AbortSignal): Promise<{ transcriptViewId: string; sourceHead: number; display: DisplayStatus }> {
    this.#exists(chatId);
    const view = await this.options.adoption.ensure(chatId, signal);
    this.#exists(chatId);
    if (expectedView && view.viewId !== expectedView) throw new StaleTranscriptViewError(chatId, expectedView, view.viewId);
    const job = this.#admit(chatId, view.viewId, true);
    return { transcriptViewId: job.viewId, sourceHead: this.#head(job).ordinal, display: this.#status(job) };
  }

  async window(request: DisplayWindowRequest, signal?: AbortSignal): Promise<DisplayWindowResponse> {
    this.#validateRevision(request.policyRevision, request.profile.bashRevision);
    const job = this.#admit(request.chatId, request.transcriptViewId, true), head = this.#head(job).ordinal;
    const frontier = this.#frontier(job, request.profile.hiddenToolGroups.includes('bash'));
    const cursor = request.anchor.kind === 'before' || request.anchor.kind === 'after' ? request.anchor.cursor.certificate : null;
    if (cursor) this.#validateCertificate(job, { certificate: cursor, profile: request.profile, cuts: request.cuts });
    const W = request.atWatermark ?? cursor?.watermark ?? Math.min(head, frontier);
    if (W > head) throw new DomainError('DISPLAY_STALE_WATERMARK', 'Transcript source changed. Refresh the window.', 409, true);
    if (!job.ready || frontier < Math.max(W, request.requiredThrough ?? 0) || this.#preparationFailure(job, request.profile, W)) {
      return this.#unavailable(job, request, head, frontier);
    }
    const response = await this.#read(job, { kind: 'window', path: job.path, request, watermark: W, sourceHead: head,
      bashFrontier: frontier, serverInstanceId: this.serverInstanceId, filteredBash: this.#patterns.length > 0 }, signal);
    this.#current(job);
    return response;
  }

  async members(request: MemberWindowRequest, signal?: AbortSignal) {
    const job = this.#certifiedJob(request);
    const result = await this.#read(job, { kind: 'members', path: job.path, request, filteredBash: this.#patterns.length > 0 }, signal);
    this.#current(job); return result;
  }

  async resolve(request: DisplayWindowRequest, ordinal: number, signal?: AbortSignal) {
    const job = this.#admit(request.chatId, request.transcriptViewId, true);
    this.#validateRevision(request.policyRevision, request.profile.bashRevision);
    const head = this.#head(job).ordinal, frontier = this.#frontier(job, request.profile.hiddenToolGroups.includes('bash'));
    const watermark = request.atWatermark ?? Math.min(head, frontier);
    if (watermark > head) throw new DomainError('DISPLAY_STALE_WATERMARK', 'Transcript source changed.', 409, true);
    this.#assertPreparationHealthy(job, request.profile, watermark);
    if (!job.ready || watermark > frontier) return { kind: 'preparing' as const, ordinal, landedOrdinal: null };
    const result = await this.#read(job, { kind: 'resolve', path: job.path, request, watermark, sourceHead: head, ordinal, filteredBash: this.#patterns.length > 0 }, signal);
    this.#current(job); return result;
  }

  async bodies(request: BodyDependencyRequest, signal?: AbortSignal): Promise<string> {
    const job = this.#certifiedJob(request);
    const plan = await this.#read(job, { kind: 'body-plan', path: job.path, request }, signal);
    this.#current(job);
    const watermark = { viewId: transcriptViewId(job.viewId), ordinal: request.certificate.watermark };
    const result = await this.options.ledger.withStoredRowsByOrdinals(job.chatId, watermark, plan.ordinals,
      rows => this.#reader.request({ kind: 'hydrate', request, plan, rows }, signal));
    this.#current(job); return result;
  }

  async retry(chatId: string): Promise<void> {
    const job = this.#jobs.get(chatId);
    if (!job) return;
    this.#current(job);
    const pending = this.#retries.get(chatId);
    if (pending?.viewId === job.viewId) return pending.promise;
    const operation = { viewId: job.viewId, promise: this.#retry(job).finally(() => {
      if (this.#retries.get(chatId) === operation) this.#retries.delete(chatId);
    }) };
    this.#retries.set(chatId, operation);
    return operation.promise;
  }

  async #retry(initial: DisplayJob): Promise<void> {
    const chatId = initial.chatId;
    clearTimeout(this.#retryTimers.get(chatId)); this.#retryTimers.delete(chatId);
    const revision = this.#revision;
    initial.auxiliaryFailure = null;
    const initialization = initial.initialize;
    let job = await this.#initializedSuccessor(initial);
    if (job === initial && job.initialize === initialization) job = await this.#initializedSuccessor(this.#reinitialize(job));
    if (job.ready && job.bash.get(revision)?.failure) {
      await this.#builder.request({ kind: 'filter-failed', path: job.path, revision, retry: true });
      this.#current(job);
      const preparation = job.bash.get(revision);
      if (preparation) preparation.failure = null;
    }
    this.#pump();
  }

  async #initializedSuccessor(job: DisplayJob): Promise<DisplayJob> {
    for (;;) {
      const initialization = job.initialize;
      await initialization;
      this.#head(job);
      const current = this.#jobs.get(job.chatId);
      // Recovery may replace a sidecar without replacing the authoritative view.
      if (!current || current.viewId !== job.viewId) this.#current(job);
      if (current && current !== job) { job = current; continue; }
      this.#current(job);
      if (job.initialize === initialization) return job;
    }
  }

  async auxiliary(kind: 'user-rows' | 'subagents', request: DisplayAuxiliaryRequest, signal?: AbortSignal) {
    const job = this.#admit(request.chatId, request.transcriptViewId, true), sourceHead = this.#head(job).ordinal;
    if (kind === 'subagents') { job.auxiliaryRequested = true; this.#pump(); }
    const frontier = kind === 'subagents' ? job.auxiliaryFrontier : job.frontier;
    const watermark = request.atWatermark ?? Math.min(frontier, sourceHead);
    if (watermark > sourceHead) throw new DomainError('DISPLAY_STALE_WATERMARK', 'Refresh transcript summaries.', 409, true);
    const identity = { serverInstanceId: this.serverInstanceId, chatId: job.chatId, transcriptViewId: job.viewId, watermark, sourceHead };
    const failure = (job.ready && frontier >= watermark && job.failure && transientDisplayFailure(job.failure) ? null : job.failure)
      ?? (kind === 'subagents' ? job.auxiliaryFailure : null);
    if (!job.ready || frontier < watermark || (frontier === 0 && sourceHead > 0) || failure) return { ...identity, watermark: Math.min(frontier, sourceHead),
      kind: failure ? 'failed' : 'preparing', errorCode: failure } satisfies AuxiliaryPreparing;
    const result = await this.#read(job, { kind, path: job.path, request, identity }, signal);
    this.#current(job); return result;
  }

  forget(chatId: string): void {
    this.#retries.delete(chatId);
    this.plans.clear(chatId);
    this.#evict(chatId);
  }

  #rebuild(job: DisplayJob): DisplayJob {
    this.#current(job);
    this.#evict(job.chatId);
    const replacement = this.#admit(job.chatId, job.viewId, false);
    replacement.activeAt = job.activeAt;
    replacement.auxiliaryRequested = job.auxiliaryRequested;
    return replacement;
  }

  #reinitialize(job: DisplayJob): DisplayJob {
    this.#current(job);
    clearTimeout(this.#retryTimers.get(job.chatId)); this.#retryTimers.delete(job.chatId);
    if (job.failure && transientDisplayFailure(job.failure) || !job.ready && this.#retirements.has(job.chatId)) {
      // Transport recovery preserves validated readers and retries the existing retirement fence.
      job.initialize = this.#initializeJob(job);
      return job;
    }
    this.#retireJob(job.chatId);
    const replacement = this.#admit(job.chatId, job.viewId, false);
    replacement.activeAt = job.activeAt;
    replacement.auxiliaryRequested = job.auxiliaryRequested;
    return replacement;
  }

  async #read<K extends DisplayWorkerTask['kind']>(job: DisplayJob, task: Extract<DisplayWorkerTask, { kind: K }>, signal?: AbortSignal): Promise<DisplayWorkerResults[K]> {
    this.#current(job);
    try {
      return await this.#reader.request(task, signal);
    } catch (error) {
      const code = errorCode(error);
      if (this.#jobs.get(job.chatId) === job && !this.#abort.signal.aborted
        && (code === 'DISPLAY_STORE_INVALID' || (code === 'DISPLAY_INDEX_FAILED' && await displayFileMissing(job.path)))) {
        if (this.#jobs.get(job.chatId) === job && !this.#abort.signal.aborted) this.#rebuild(job);
      }
      throw error;
    }
  }

  #evict(chatId: string): Retirement {
    if (this.#jobs.has(chatId)) this.#frames.evictions++;
    this.#retireJob(chatId);
    const file = this.#files.get(chatId);
    return this.#scheduleRetirement(chatId, 'eviction', async () => {
      await rm(path.join(this.#root, chatId), { recursive: true, force: true });
      if (this.#files.get(chatId) === file) this.#files.delete(chatId);
    });
  }

  #retireJob(chatId: string): void {
    clearTimeout(this.#statusTimers.get(chatId)); this.#statusTimers.delete(chatId);
    clearTimeout(this.#retryTimers.get(chatId)); this.#retryTimers.delete(chatId);
    const job = this.#jobs.get(chatId); this.#jobs.delete(chatId);
    const initialization = job?.initialize;
    this.#scheduleRetirement(chatId, 'maintenance', async () => {
      await initialization;
      if (job) {
        await this.#builder.request({ kind: 'close', path: job.path });
        await this.#reader.request({ kind: 'close', path: job.path });
      }
    });
  }

  #scheduleRetirement(chatId: string, kind: Retirement['kind'], work: () => Promise<void>): Retirement {
    const previous = this.#retirements.get(chatId);
    const retirement: Retirement = { kind, failed: true, promise: Promise.resolve(), work: async () => {
      if (previous) await this.#resumeRetirement(chatId, previous);
      await work();
    } };
    this.#retirements.set(chatId, retirement);
    void this.#resumeRetirement(chatId, retirement).catch(() => undefined);
    return retirement;
  }

  #resumeRetirement(chatId: string, retirement: Retirement): Promise<void> {
    if (retirement.failed) {
      retirement.failed = false;
      retirement.promise = Promise.resolve().then(retirement.work).then(() => {
        if (this.#retirements.get(chatId) === retirement) this.#retirements.delete(chatId);
      }, error => { retirement.failed = true; throw error; });
    }
    return retirement.promise;
  }

  async close(): Promise<void> {
    this.#abort.abort(); this.#unsubscribe();
    this.#retries.clear();
    for (const timer of this.#statusTimers.values()) clearTimeout(timer);
    this.#statusTimers.clear();
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#retryTimers.clear();
    await this.#running;
    for (const job of this.#jobs.values()) await job.initialize;
    for (const retirement of this.#retirements.values()) await retirement.promise.catch(() => undefined);
    await this.#builder.close(); await this.#reader.close(); this.#jobs.clear();
  }

  #admit(chatId: string, viewId: string, visible: boolean): DisplayJob {
    this.#exists(chatId);
    const head = this.options.ledger.highWatermark(chatId);
    if (head.viewId !== viewId) throw new StaleTranscriptViewError(chatId, viewId, head.viewId);
    let job = this.#jobs.get(chatId);
    if (job && job.viewId !== viewId) { this.forget(chatId); job = undefined; }
    if (!job) {
      job = { chatId, viewId, path: path.join(this.#root, chatId, displayFilename(viewId)),
        frontier: 0, goal: head.ordinal, tailOrdinal: null, ready: false, failure: null, activeAt: 0,
        bash: new Map(), auxiliaryFrontier: 0, auxiliaryRequested: false, auxiliaryFailure: null,
        phase: 'structure', initialize: Promise.resolve(), fileIdentity: null };
      this.#jobs.set(chatId, job);
      job.initialize = this.#initializeJob(job);
    }
    if (visible) {
      job.activeAt = Date.now();
      const file = this.#files.get(chatId);
      if (file) file.usedAt = job.activeAt;
    }
    job.goal = head.ordinal; this.#pump(); return job;
  }

  async #initializeJob(job: DisplayJob): Promise<void> {
    try {
      const retirement = this.#retirements.get(job.chatId);
      if (retirement) await this.#resumeRetirement(job.chatId, retirement);
      this.#current(job);
      ensureLedgerChatDirectory(this.#root, job.chatId);
      await this.#admitDisk(job); this.#current(job);
      const inspect = () => this.#builder.request({ kind: 'inspect', path: job.path, chatId: job.chatId, viewId: job.viewId, serverInstanceId: this.serverInstanceId });
      let info;
      try { info = await inspect(); } catch (error) {
        if (errorCode(error) !== 'DISPLAY_STORE_INVALID') throw error;
        if (job.ready) { this.#rebuild(job); return; }
        await this.#discardFile(job); info = await inspect();
      }
      this.#current(job);
      const file = await lstat(job.path);
      this.#current(job);
      const fileIdentity = `${file.dev}:${file.ino}`;
      // Cached readers belong to the inspected file, not merely its pathname.
      if (job.ready && (fileIdentity !== job.fileIdentity || info.manifest.prepared_through < job.frontier)) {
        this.#rebuild(job); return;
      }
      const head = this.#head(job), recovered = this.options.ledger.recoveredHead(job.chatId), manifest = info.manifest;
      const validRecovery = manifest.written_by_server_instance === this.serverInstanceId
        || (recovered?.viewId === job.viewId && manifest.prepared_through <= recovered.ordinal)
        || manifest.prepared_through === 0;
      const row = manifest.prepared_through && manifest.prepared_through <= head.ordinal
        ? this.options.ledger.storedRowsByOrdinals(job.chatId, head, [manifest.prepared_through])[0] ?? null : null;
      if (!validRecovery || manifest.prepared_through > head.ordinal || sourceFingerprint(row) !== manifest.frontier_fingerprint
        || info.revisions.some(revision => revision.prepared_through > manifest.prepared_through)
        || info.auxiliaryFrontier > manifest.prepared_through || info.auxiliaryBuilding > manifest.prepared_through
        || info.auxiliaryCursor > info.auxiliaryBuilding || info.auxiliaryGeneration > info.auxiliaryFrontier
        || info.auxiliaryRelevantThrough > manifest.prepared_through) {
        if (job.ready) { this.#rebuild(job); return; }
        await this.#discardFile(job); info = await inspect(); this.#current(job);
      }
      const admittedFile = await lstat(job.path);
      this.#current(job);
      job.fileIdentity = `${admittedFile.dev}:${admittedFile.ino}`;
      job.frontier = info.manifest.prepared_through; job.tailOrdinal = info.tailOrdinal; job.auxiliaryFrontier = info.auxiliaryFrontier;
      job.bash.clear();
      for (const revision of info.revisions) job.bash.set(revision.revision, { frontier: revision.status === 'pruning' ? 0 : revision.prepared_through,
        failure: revision.failure_code, pruning: revision.status === 'pruning' });
      job.failure = null; job.ready = true; this.#notify(job); this.#pump();
      await this.#recordFileSize(job);
    } catch (error) {
      if (this.#jobs.get(job.chatId) !== job || this.#abort.signal.aborted) return;
      this.#fail(job, error);
    }
  }

  async #discardFile(job: DisplayJob): Promise<void> {
    await this.#builder.request({ kind: 'close', path: job.path }); await this.#reader.request({ kind: 'close', path: job.path });
    this.#current(job);
    for (const suffix of ['', '-wal', '-shm']) await rm(job.path + suffix, { force: true });
  }

  #pump(): void {
    if (this.#abort.signal.aborted) return;
    if (this.#running) { this.#wakePending = true; return; }
    this.#wakePending = false;
    this.#running = this.#work().finally(() => {
      this.#running = null;
      if (this.#wakePending) this.#pump();
    });
  }

  #needsBashWork(job: DisplayJob): boolean {
    if ([...job.bash.values()].some(revision => revision.pruning)) return true;
    const preparation = job.bash.get(this.#revision);
    return this.#patterns.length > 0 && !preparation?.failure && (preparation?.frontier ?? -1) < job.frontier;
  }

  #needsAuxiliaryWork(job: DisplayJob): boolean {
    return job.auxiliaryRequested && !job.auxiliaryFailure && job.auxiliaryFrontier < job.frontier;
  }

  async #work(): Promise<void> {
    for (;;) {
      if (this.#abort.signal.aborted) return;
      const eligible = [...this.#jobs.values()].filter(job => job.ready && !job.failure
        && (job.frontier < job.goal || this.#needsBashWork(job) || this.#needsAuxiliaryWork(job)));
      if (!eligible.length) return;
      const now = Date.now(), visible = eligible.filter(job => now - job.activeAt < 10000), background = eligible.filter(job => now - job.activeAt >= 10000);
      const job = this.#visibleFrames >= 8 && background.length ? background[0] : visible[0] ?? background[0];
      this.#visibleFrames = now - job.activeAt < 10000 ? this.#visibleFrames + 1 : 0;
      this.#jobs.delete(job.chatId); this.#jobs.set(job.chatId, job);
      const started = performance.now();
      try {
        this.#current(job);
        await this.#admitDisk(job); this.#current(job);
        const revision = this.#revision, patterns = this.#patterns;
        const phases = ['structure', 'bash', 'auxiliary'] as const;
        const start = phases.indexOf(job.phase);
        const phase = [...phases.slice(start), ...phases.slice(0, start)].find(phase => {
          switch (phase) {
            case 'structure': return job.frontier < job.goal;
            case 'bash': return this.#needsBashWork(job);
            case 'auxiliary': return this.#needsAuxiliaryWork(job);
          }
        });
        if (phase === 'auxiliary') {
          try {
            job.auxiliaryFrontier = await this.#builder.request({ kind: 'auxiliary-frame', path: job.path, goal: job.frontier });
            this.#current(job);
          } catch (error) {
            this.#current(job);
            if (transientDisplayFailure(errorCode(error)) || errorCode(error) === 'DISPLAY_STORE_INVALID') throw error;
            job.auxiliaryFailure = errorCode(error);
          }
          job.phase = 'structure';
        } else if (phase === 'structure') {
          const goal: TranscriptWatermark = { viewId: transcriptViewId(job.viewId), ordinal: job.goal };
          const previousTail = job.tailOrdinal ? this.options.ledger.storedRowsByOrdinals(job.chatId, goal, [job.tailOrdinal])[0] : undefined;
          await this.options.ledger.withStoredRowFrames(job.chatId, goal, job.frontier + 1, async frames => {
            for await (const rows of frames) {
              this.#current(job);
              this.#frames.count++;
              this.#frames.rows += rows.length;
              this.#frames.estimatedBytes += rows.reduce((bytes, row) => bytes + row.payload_json.length * 2, 0);
              const result = await this.#builder.request({ kind: 'frame', path: job.path, rows, goal: goal.ordinal,
                serverInstanceId: this.serverInstanceId, previousTail });
              this.#current(job); job.frontier = result.frontier; job.tailOrdinal = result.tailOrdinal; break;
            }
          }, this.#abort.signal);
          job.phase = 'bash';
        } else if (phase === 'bash') {
          const obsolete = [...job.bash].find(([, value]) => value.pruning)?.[0]
            ?? (job.bash.size >= 2 && !job.bash.has(revision) ? job.bash.keys().next().value : undefined);
          if (obsolete !== undefined) {
            this.#current(job);
            job.bash.set(obsolete, { frontier: 0, failure: null, pruning: true });
            const complete = await this.#builder.request({ kind: 'prune', path: job.path, revision: obsolete });
            this.#current(job);
            if (complete) job.bash.delete(obsolete);
          } else if (patterns.length) {
            try {
              this.#current(job);
              const frontier = await this.#builder.request({ kind: 'bash', path: job.path, revision, patterns, goal: job.frontier }, undefined, 2000);
              this.#current(job); job.bash.set(revision, { frontier, failure: null, pruning: false });
            } catch (error) {
              if (errorCode(error) !== 'DISPLAY_FILTER_TIMEOUT') throw error;
              this.#current(job);
              await this.#builder.request({ kind: 'filter-failed', path: job.path, revision, retry: false });
              this.#current(job);
              job.bash.set(revision, { frontier: job.bash.get(revision)?.frontier ?? 0, failure: 'DISPLAY_FILTER_TIMEOUT', pruning: false });
            }
          }
          job.phase = 'auxiliary';
        }
        this.#notify(job);
        await this.#recordFileSize(job);
      } catch (error) {
        if (this.#jobs.get(job.chatId) === job && !this.#abort.signal.aborted) {
          try {
            if (errorCode(error) === 'DISPLAY_STORE_INVALID') this.#rebuild(job);
            else this.#fail(job, error);
          } catch (rebuildError) {
            if (this.#jobs.get(job.chatId) === job) this.#fail(job, rebuildError);
          }
        }
      }
      await Bun.sleep(Math.min(100, Math.max(1, performance.now() - started)));
    }
  }

  #frontier(job: DisplayJob, hidesBash = false): number {
    return hidesBash || this.#patterns.length === 0 ? job.frontier : Math.min(job.frontier, job.bash.get(this.#revision)?.frontier ?? 0);
  }
  #fail(job: DisplayJob, error: unknown): void {
    job.failure = errorCode(error);
    if (!transientDisplayFailure(job.failure)) job.ready = false;
    this.#notify(job);
    if (!transientDisplayFailure(job.failure) || this.#retryTimers.has(job.chatId)) return;
    this.#retryTimers.set(job.chatId, setTimeout(() => {
      this.#retryTimers.delete(job.chatId);
      if (this.#abort.signal.aborted || this.#jobs.get(job.chatId) !== job) return;
      try { this.#reinitialize(job); }
      catch (error) { if (this.#jobs.get(job.chatId) === job) this.#fail(job, error); }
    }, 1000));
  }
  async #recordFileSize(job: DisplayJob): Promise<void> {
    const bytes = await displayFileBytes(job.path);
    this.#current(job);
    this.#files.set(job.chatId, { bytes, usedAt: job.activeAt });
  }
  async #admitDisk(job: DisplayJob): Promise<void> {
    const estimate = 2 * 1024 * 1024, budget = this.options.diskBudget ?? 1024 * 1024 * 1024;
    let total = [...this.#files.values()].reduce((sum, file) => sum + file.bytes, 0);
    const disk = await statfs(this.#root); this.#current(job);
    let free = disk.bavail * disk.bsize;
    const enough = () => total + estimate <= budget && free >= (this.options.freeSpaceReserve ?? 256 * 1024 * 1024) + estimate;
    if (enough()) return;
    const inactive = [...this.#files].filter(([chatId, file]) => chatId !== job.chatId && Date.now() - file.usedAt >= 10000)
      .sort((left, right) => left[1].usedAt - right[1].usedAt);
    for (const [chatId] of inactive) {
      this.#current(job);
      const existing = this.#retirements.get(chatId);
      const retirement = existing?.kind === 'eviction' && !this.#jobs.has(chatId) ? existing : this.#evict(chatId);
      const removed = await this.#resumeRetirement(chatId, retirement).then(() => true, () => false);
      this.#current(job);
      if (!removed) continue;
      total = [...this.#files.values()].reduce((sum, file) => sum + file.bytes, 0);
      const available = await statfs(this.#root); this.#current(job);
      free = available.bavail * available.bsize;
      if (enough()) return;
      await Bun.sleep(0);
    }
    throw new DomainError('DISPLAY_DISK_FULL', 'Transcript display preparation needs more free space.', 503, true);
  }
  auxiliaryRevision(chatId: string, viewId: string): number {
    const job = this.#jobs.get(chatId);
    return job?.viewId === viewId ? job.auxiliaryFrontier : 0;
  }

  get metrics() {
    return { ...this.#frames, jobs: this.#jobs.size, retirements: this.#retirements.size,
      derivedBytes: [...this.#files.values()].reduce((bytes, file) => bytes + file.bytes, 0),
      builder: this.#builder.metrics, reader: this.#reader.metrics,
      frontiers: [...this.#jobs.values()].map(job => ({ chatId: job.chatId, sourceHead: job.goal,
        preparedThrough: this.#frontier(job), auxiliaryThrough: job.auxiliaryFrontier,
        lag: Math.max(0, job.goal - this.#frontier(job)), failed: job.failure !== null })) };
  }

  #status(job: DisplayJob): DisplayStatus {
    const preparedThrough = this.#frontier(job), errorCode = job.failure ?? job.bash.get(this.#revision)?.failure ?? null;
    let phase: DisplayStatus['phase'] = 'preparing';
    if (errorCode) phase = 'failed';
    else if (job.ready && preparedThrough >= job.goal) phase = 'available';
    return { chatId: job.chatId, transcriptViewId: job.viewId, policyRevision: DISPLAY_POLICY_REVISION, bashRevision: this.#revision,
      preparedThrough, structuralPreparedThrough: job.frontier, auxiliaryRevision: job.auxiliaryFrontier,
      phase, errorCode };
  }
  #notify(job: DisplayJob): void {
    if (this.#abort.signal.aborted || this.#statusTimers.has(job.chatId)) return;
    this.#statusTimers.set(job.chatId, setTimeout(() => {
      this.#statusTimers.delete(job.chatId);
      if (this.#jobs.get(job.chatId) === job) this.options.onStatus?.(this.#status(job));
    }, 250));
  }
  #unavailable(job: DisplayJob, request: DisplayWindowRequest, head: number, frontier: number): DisplayUnavailable {
    const failure = this.#preparationFailure(job, request.profile);
    let kind: DisplayUnavailable['kind'] = 'preparing';
    if (failure) kind = 'failed';
    else if (job.frontier) kind = 'lagging';
    return { kind, serverInstanceId: this.serverInstanceId,
      chatId: job.chatId, transcriptViewId: job.viewId, policyRevision: DISPLAY_POLICY_REVISION, profileKey: displayProfileKey(request.profile),
      bashRevision: this.#revision, sourceHead: head, preparedThrough: frontier, errorCode: failure ?? null, retryAfterMs: failure ? null : 250 };
  }
  #certifiedJob(request: CertifiedDisplayRequest): DisplayJob {
    const job = this.#admit(request.certificate.chatId, request.certificate.transcriptViewId, true);
    this.#validateCertificate(job, request); return job;
  }
  #assertPreparationHealthy(job: DisplayJob, profile: DisplayWindowRequest['profile'], through: number): void {
    const failure = this.#preparationFailure(job, profile, through);
    if (failure) throw new DomainError(isErrorCode(failure) ? failure : 'DISPLAY_INDEX_FAILED',
      `Transcript display preparation failed (${failure}). Retry the display.`, 503, transientDisplayFailure(failure));
  }
  #preparationFailure(job: DisplayJob, profile: DisplayWindowRequest['profile'], through = Infinity): string | null {
    if (job.failure !== null && (!transientDisplayFailure(job.failure) || !job.ready
      || through > this.#frontier(job, profile.hiddenToolGroups.includes('bash')))) return job.failure;
    if (profile.hiddenToolGroups.includes('bash')) return null;
    return job.bash.get(this.#revision)?.failure ?? null;
  }
  #validateCertificate(job: DisplayJob, request: CertifiedDisplayRequest): void {
    const cert = request.certificate;
    this.#validateRevision(cert.policyRevision, cert.bashRevision);
    if (cert.serverInstanceId !== this.serverInstanceId || cert.chatId !== job.chatId || cert.transcriptViewId !== job.viewId
      || cert.profileKey !== displayProfileKey(request.profile) || cert.cutsKey !== displayCutsKey(request.cuts)
      || cert.bashRevision !== request.profile.bashRevision || cert.watermark > this.#head(job).ordinal) {
      throw new DomainError('DISPLAY_STALE_CERTIFICATE', 'Refresh this transcript window.', 409, true);
    }
    this.#assertPreparationHealthy(job, request.profile, cert.watermark);
    if (!job.ready || cert.watermark > this.#frontier(job, request.profile.hiddenToolGroups.includes('bash'))) throw new DomainError('DISPLAY_PREPARING', 'Transcript display is preparing.', 503, true);
  }
  #validateRevision(policy: number, bash: string): void {
    if (policy !== DISPLAY_POLICY_REVISION || bash !== this.#revision) throw new DomainError('DISPLAY_REVISION_CHANGED', 'Transcript display settings changed.', 409, true);
  }
  #head(job: DisplayJob): TranscriptWatermark {
    return this.currentHead(job.chatId, job.viewId);
  }
  #current(job: DisplayJob): void {
    this.#exists(job.chatId);
    if (this.#jobs.get(job.chatId) !== job) throw new DomainError('DISPLAY_SUPERSEDED', 'Transcript display request was superseded.', 409, true);
    this.#head(job);
  }
  #exists(chatId: string): void {
    if (this.#abort.signal.aborted) throw new DomainError('SERVER_SHUTTING_DOWN', 'Server is shutting down.', 503, true);
    if (!/^[A-Za-z0-9_-]+$/.test(chatId) || !this.options.hasChat(chatId)) throw new DomainError('SESSION_NOT_FOUND', 'Chat not found.', 404, false);
  }
}

function displayFilename(viewId: string): string {
  return `${createHash('sha256').update(JSON.stringify([viewId, DISPLAY_POLICY_REVISION])).digest('hex')}.sqlite`;
}

async function displayFileMissing(filename: string): Promise<boolean> {
  try { await lstat(filename); return false; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
}

async function displayFileBytes(filename: string): Promise<number> {
  let bytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { bytes += (await lstat(filename + suffix)).size; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  return bytes;
}
