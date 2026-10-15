import crypto from 'node:crypto';
import type { PullRequestSummary } from '../../../common/gh.js';
import {
  PULL_REQUEST_REVIEW_MAX_RUNNING,
  PULL_REQUEST_REVIEW_PERMISSION_TIMEOUT_MINUTES,
  PULL_REQUEST_REVIEW_TAG,
  isActivePullRequestReviewRun,
  parseReviewedCommit,
  renderPullRequestReviewPrompt,
} from '../../../common/pull-request-reviews.js';
import { normalizeTags } from '../../../common/tags.js';
import { errorMessage } from '../../common/errors.js';
import { createLogger } from '../../common/log.js';
import type { ChatIdAllocator } from '../chats/chat-id-allocator.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import type { CommandLedger, CommandLedgerRecord } from '../commands/command-ledger.js';
import { projectAgentTurnReceipt } from '../commands/agent-turn-receipt-projector.js';
import type { ScheduledChatStartInput } from '../commands/command-support.js';
import type { TranscriptCommitEvent } from '../ledger/service.js';
import { reviewConflict } from './errors.js';
import type { PullRequestReviewPoster } from './poster.js';
import type { PullRequestReviewStore, StoredRun } from './store.js';

const logger = createLogger('pull-request-review-runner');

export interface PullRequestReviewRunnerDeps {
  store: PullRequestReviewStore;
  poster: Pick<PullRequestReviewPoster, 'post'>;
  commands: Pick<ChatCommandService, 'submitScheduledStart' | 'submitStop'>;
  chatIds: Pick<ChatIdAllocator, 'allocate'>;
  turns: Pick<CommandLedger, 'waitForTurnTerminal'>;
  chatNames: { setSessionName(chatId: string, title: string): Promise<unknown> };
  changed(): void;
  now(): number;
}

type Settlement = Pick<StoredRun, 'state' | 'message' | 'reviewedSha'> & { review?: string };

// Starts review chats for queued runs within the concurrency limits and records how each turn ends.
export class PullRequestReviewRunner {
  readonly #abort = new AbortController();
  #started = false;
  // Active review chats, so permission events can be matched to their runs.
  readonly #runByChat = new Map<string, string>();
  readonly #pendingPermissions = new Map<string, Set<string>>();
  readonly #permissionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #permissionTimedOut = new Set<string>();
  readonly #starting = new Set<string>();

  constructor(private readonly deps: PullRequestReviewRunnerDeps) {}

  // Review chats start only after the controller's terminal consumers are installed.
  start(): void {
    this.#started = true;
    this.pump();
  }

  stop(): void {
    this.#abort.abort();
    for (const timer of this.#permissionTimers.values()) clearTimeout(timer);
    this.#permissionTimers.clear();
    this.#runByChat.clear();
    this.#pendingPermissions.clear();
    this.#permissionTimedOut.clear();
  }

  enqueue(repositoryId: string, pull: PullRequestSummary, trigger: 'auto' | 'manual'): StoredRun {
    const active = this.deps.store.runsForRepository(repositoryId)
      .find((run) => run.number === pull.number && isActivePullRequestReviewRun(run.state));
    if (active) throw reviewConflict('This pull request is already being reviewed.');
    const run: StoredRun = {
      id: crypto.randomUUID(),
      repositoryId,
      number: pull.number,
      headSha: pull.headRefOid,
      state: 'queued',
      createdAt: new Date(this.deps.now()).toISOString(),
      title: pull.title,
      reviewedSha: null,
      trigger,
      message: null,
      chatId: null,
      turnId: null,
      startedAt: null,
      finishedAt: null,
      post: { status: 'none', commentUrl: null, postedAt: null, message: null },
      chatArchived: false,
    };
    this.deps.store.insertRun(run);
    this.deps.changed();
    return run;
  }

  // Starts as many queued runs, oldest first, as the limits allow.
  pump(): void {
    if (!this.#started || this.#abort.signal.aborted) return;
    const active = this.deps.store.activeRuns();
    const running = active.filter((run) => run.state !== 'queued' || this.#starting.has(run.id));
    for (const run of active) {
      if (run.state !== 'queued' || this.#starting.has(run.id)) continue;
      if (running.length >= PULL_REQUEST_REVIEW_MAX_RUNNING) return;
      if (running.some((entry) => entry.repositoryId === run.repositoryId)) continue;
      running.push(run);
      this.#starting.add(run.id);
      void this.#start(run).finally(() => {
        this.#starting.delete(run.id);
        this.pump();
      });
    }
  }

  async stopRun(runId: string): Promise<void> {
    const run = this.deps.store.getRun(runId);
    if (!run || !isActivePullRequestReviewRun(run.state)) throw reviewConflict('This review is not running.');
    if (run.state === 'queued' && !this.#starting.has(runId)) {
      this.#settle(runId, { state: 'stopped', message: 'Stopped before it started.', reviewedSha: null });
      return;
    }
    if (!run.chatId) throw reviewConflict('This review is still starting. Try again in a moment.');
    await this.deps.commands.submitStop({ chatId: run.chatId, clientRequestId: `pull-request-review-stop:${crypto.randomUUID()}` });
  }

  handleTranscriptCommit(event: TranscriptCommitEvent): void {
    if (this.#abort.signal.aborted || event.type !== 'permission') return;
    const runId = this.#runByChat.get(event.chatId);
    if (!runId) return;
    const pending = this.#pendingPermissions.get(runId) ?? new Set<string>();
    const lifecycle = event.row.lifecycle;
    if (lifecycle.kind === 'requested') pending.add(lifecycle.permissionOccurrenceId);
    else pending.delete(lifecycle.permissionOccurrenceId);
    this.#pendingPermissions.set(runId, pending);
    const needsInput = pending.size > 0;
    const updated = this.deps.store.updateRun(runId, (run) => {
      const next = needsInput ? 'needs-input' : 'reviewing';
      return run.state === 'reviewing' || run.state === 'needs-input'
        ? (run.state === next ? null : { ...run, state: next })
        : null;
    });
    if (needsInput && !this.#permissionTimers.has(runId)) {
      const timer = setTimeout(() => void this.#expirePermission(runId, event.chatId), PULL_REQUEST_REVIEW_PERMISSION_TIMEOUT_MINUTES * 60_000);
      timer.unref?.();
      this.#permissionTimers.set(runId, timer);
    } else if (!needsInput) {
      this.#clearPermissionTimer(runId);
    }
    if (updated) this.deps.changed();
  }

  async #expirePermission(runId: string, chatId: string): Promise<void> {
    this.#permissionTimers.delete(runId);
    this.#permissionTimedOut.add(runId);
    try {
      await this.deps.commands.submitStop({ chatId, clientRequestId: `pull-request-review-timeout:${runId}` });
    } catch (error) {
      logger.warn('Could not stop a review waiting on a permission request.', { error: errorMessage(error) });
    }
  }

  #clearPermissionTimer(runId: string): void {
    const timer = this.#permissionTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.#permissionTimers.delete(runId);
  }

  async #start(queued: StoredRun): Promise<void> {
    const { store } = this.deps;
    const repository = store.getRepository(queued.repositoryId);
    if (!repository) return;
    const chatId = this.deps.chatIds.allocate();
    const started = store.updateRun(queued.id, (run) => run.state === 'queued'
      ? { ...run, state: 'reviewing', chatId, startedAt: new Date(this.deps.now()).toISOString() }
      : null);
    if (!started) return;
    this.#runByChat.set(chatId, queued.id);
    this.deps.changed();
    const { target } = repository;
    let turnId: string | null;
    try {
      const input: ScheduledChatStartInput = {
        executorId: target.executorId,
        chatId,
        clientRequestId: `pull-request-review:${queued.id}`,
        clientMessageId: `pull-request-review-message:${queued.id}`,
        agentId: target.agentId,
        projectPath: target.projectPath,
        command: renderPullRequestReviewPrompt(repository.settings.prompt, {
          repository: repository.nameWithOwner,
          number: queued.number,
          projectPath: target.projectPath,
        }),
        model: target.model,
        apiProviderId: target.apiProviderId,
        modelEndpointId: target.modelEndpointId,
        modelProtocol: target.modelProtocol,
        permissionMode: target.permissionMode,
        thinkingMode: target.thinkingMode,
        agentSettingsById: target.agentSettingsById,
        tags: normalizeTags([...target.tags, PULL_REQUEST_REVIEW_TAG]),
      };
      if (target.preambleChoice.mode === 'explicit') input.orderedPreambleIds = [...target.preambleChoice.orderedPreambleIds];
      const result = await this.deps.commands.submitScheduledStart(input);
      turnId = result.turnId ?? null;
    } catch (error) {
      this.#runByChat.delete(chatId);
      this.#settle(queued.id, { state: 'failed', message: errorMessage(error, 'The review chat could not start.'), reviewedSha: null });
      return;
    }
    if (!turnId) {
      this.#runByChat.delete(chatId);
      this.#settle(queued.id, { state: 'failed', message: 'The review chat started without a turn to follow.', reviewedSha: null });
      return;
    }
    store.updateRun(queued.id, (run) => ({ ...run, turnId }));
    void this.deps.chatNames.setSessionName(chatId, `Review ${repository.nameWithOwner}#${queued.number}`)
      .catch((error) => logger.warn('Could not name a review chat.', { error: errorMessage(error) }));
    let record: CommandLedgerRecord | null;
    try {
      record = await this.deps.turns.waitForTurnTerminal(chatId, turnId, this.#abort.signal);
    } catch (error) {
      if (this.#abort.signal.aborted) return;
      record = null;
      logger.warn('Lost track of a review turn.', { error: errorMessage(error) });
    }
    this.#runByChat.delete(chatId);
    this.#settle(queued.id, this.#settlement(queued.id, record));
    const settled = store.getRun(queued.id);
    if (settled?.state !== 'completed') return;
    if (repository.settings.posting === 'comment' && store.getRepository(queued.repositoryId)?.settings.posting === 'comment') {
      await this.deps.poster.post(queued.id).catch((error) => logger.warn('Automatic review posting failed.', { error: errorMessage(error) }));
    }
  }

  #settlement(runId: string, record: CommandLedgerRecord | null): Settlement {
    const timedOut = this.#permissionTimedOut.has(runId);
    if (!record) return { state: 'failed', message: 'The review result is no longer available.', reviewedSha: null };
    const projection = projectAgentTurnReceipt(record);
    if (projection.kind === 'expired' || projection.receipt.state === 'pending') {
      return { state: 'failed', message: 'The review result is no longer available.', reviewedSha: null };
    }
    const { receipt } = projection;
    if (receipt.state === 'interrupted') {
      if (timedOut) return { state: 'failed', message: 'A permission request went unanswered, so the review was stopped.', reviewedSha: null };
      return {
        state: 'stopped',
        message: receipt.reason === 'chat-deleted' ? 'The review chat was deleted.' : 'Stopped by the user.',
        reviewedSha: null,
      };
    }
    if (receipt.state === 'failed') return { state: 'failed', message: receipt.error, reviewedSha: null };
    if (receipt.output.availability !== 'available') {
      return { state: 'failed', message: 'The agent finished without a final response.', reviewedSha: null };
    }
    const review = receipt.output.text;
    const reviewedSha = parseReviewedCommit(review);
    if (!reviewedSha) {
      return { state: 'failed', message: 'The review does not name the commit it reviewed.', reviewedSha: null, review };
    }
    return { state: 'completed', message: null, reviewedSha, review };
  }

  #settle(runId: string, settlement: Settlement): void {
    this.#clearPermissionTimer(runId);
    this.#pendingPermissions.delete(runId);
    this.#permissionTimedOut.delete(runId);
    const { review, ...fields } = settlement;
    const updated = this.deps.store.updateRun(runId, (run) => ({
      ...run,
      ...fields,
      finishedAt: run.finishedAt ?? new Date(this.deps.now()).toISOString(),
    }), review);
    if (updated) this.deps.changed();
  }
}
