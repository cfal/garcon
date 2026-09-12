import { isIssueReadCommand, type GarconIssueCommand, type GarconIssueMutationCommand,
  type GarconIssueReadCommand } from '../../common/garcon-issue-command.js';
import { garconIssueResultContent, issueCommandOutcome, issueCommandOutcomeContent,
  issueMutationReceipt, parseIssueCommandResult, type GarconIssueResult } from '../../common/garcon-issue-result.js';
import { parseMarkupIssueMutationPayload } from '../../common/issue-commands.js';
import { issueBytes } from '../../common/issue-validation.js';
import { ISSUE_LIMITS, type IssueProjectDefault } from '../../common/issues.js';
import { AgentCommandReplies, type AgentCommandContext } from '../chats/agent-command-replies.js';
import type { AgentCommandSource } from '../ledger/garcon-command-publication.js';
import { markupIssueContext, type IssueMutationContext } from './contracts.js';
import { IssueDomainError, validateIssueInput } from './errors.js';
import { resolveIssueProjectDefault } from './project-default.js';
import type { IssueReadBudget } from './queries.js';
import type { IssueRuntime } from './setup.js';

export interface IssueCommandControllerOptions extends AgentCommandContext {
  readonly issues: Pick<IssueRuntime, 'service'>;
  readonly resolveProject?: (directory: string, signal: AbortSignal) => Promise<IssueProjectDefault>;
}

export class IssueCommandController {
  readonly #replies: AgentCommandReplies;

  constructor(private readonly options: IssueCommandControllerOptions) {
    this.#replies = new AgentCommandReplies(options);
  }

  request(source: AgentCommandSource, command: GarconIssueCommand): void {
    let capturedStore: { storeId: string } | { error: unknown };
    try { capturedStore = { storeId: this.options.issues.service.storeId }; }
    catch (error) { capturedStore = { error }; }
    this.#replies.launch(source, async (signal) => {
      let result: GarconIssueResult;
      try {
        if ('error' in capturedStore) throw capturedStore.error;
        result = isIssueReadCommand(command)
          ? await this.#locked(source, signal, capturedStore.storeId, () => this.#read(source, command))
          : await this.#mutate(source, command, signal, capturedStore.storeId);
      } catch (error) {
        if (signal.aborted) return;
        const failure = error instanceof IssueDomainError ? error
          : new IssueDomainError('ISSUE_INTERNAL_ERROR', 'The issue command could not complete. Retry with the same ref to confirm its outcome.');
        this.#replies.report(source, 'issue-command', failure);
        result = parseIssueCommandResult({ ...identity(source, command), status: 'error',
          errorCode: failure.code, message: failure.message });
      }
      await this.#reply(source, result, signal);
    });
  }

  discardSource(chatId: string): void { this.#replies.discardSource(chatId); }
  shutdown(): void { this.#replies.shutdown(); }

  #locked<T>(source: AgentCommandSource, signal: AbortSignal, storeId: string, operation: () => T): Promise<T> {
    return this.options.chatMutationLock.runExclusive(`chat:${source.chatId}`, async () => {
      signal.throwIfAborted();
      if (!this.#replies.current(source, signal)) throw sourceUnavailable();
      if (!this.options.isEnabled()) throw new IssueDomainError('ISSUE_COMMANDS_DISABLED', 'Agent issue commands are disabled.');
      if (this.options.issues.service.storeId !== storeId) {
        throw new IssueDomainError('ISSUE_STORE_CHANGED', 'Issue storage changed before this command completed.');
      }
      return operation();
    });
  }

  #read(source: AgentCommandSource, command: GarconIssueReadCommand): GarconIssueResult {
    const success = (data: unknown) => parseIssueCommandResult({ ...identity(source, command), status: 'ok', data });
    const budget: IssueReadBudget = { maxBytes: ISSUE_LIMITS.markupBytes,
      measure: (data) => issueBytes(garconIssueResultContent(success(data))) };
    const service = this.options.issues.service;
    const payload = command.payload;
    switch (payload.action) {
      case 'list': return success(service.list(payload.query, budget));
      case 'read': return success(service.read(payload.query, { kind: 'chat', chatId: source.chatId }, budget));
      case 'history': return success(service.history(payload.query, budget));
    }
  }

  async #mutate(source: AgentCommandSource, command: GarconIssueMutationCommand,
    signal: AbortSignal, storeId: string): Promise<GarconIssueResult> {
    const payload = validateIssueInput(() => parseMarkupIssueMutationPayload(command.payload));
    const context = markupIssueContext(storeId, { chatId: source.chatId, transcriptViewId: source.viewId,
      ordinal: source.requestOrdinal }, command.ref, payload);
    const prepared = await this.#locked(source, signal, storeId, () => {
      const service = this.options.issues.service;
      const previous = service.lookupOperation(context);
      if (previous) return { kind: 'complete' as const, result: this.#mutationResult(source, command, previous) };
      if (payload.action === 'create' && payload.input.project === undefined) {
        return { kind: 'resolve-project' as const, directory: this.options.registry.getChat(source.chatId)!.projectPath };
      }
      return { kind: 'complete' as const, result: this.#execute(source, command, context) };
    });
    if (prepared.kind === 'complete') return prepared.result;
    const probe = await (this.options.resolveProject ?? resolveIssueProjectDefault)(prepared.directory, signal).then(
      (value) => ({ value }), (error: unknown) => ({ error }),
    );
    return this.#locked(source, signal, storeId, () => {
      const previous = this.options.issues.service.lookupOperation(context);
      if (previous) return this.#mutationResult(source, command, previous);
      if (this.options.registry.getChat(source.chatId)!.projectPath !== prepared.directory) throw sourceUnavailable();
      if ('error' in probe) throw probe.error;
      return this.#execute(source, command, context, probe.value.project);
    });
  }

  #execute(source: AgentCommandSource, command: GarconIssueMutationCommand,
    context: IssueMutationContext, project?: string): GarconIssueResult {
    const payload = command.payload;
    const resolved = payload.action === 'create'
      ? { ...payload, input: { ...payload.input, project: payload.input.project ?? project! } } : payload;
    return this.#mutationResult(source, command, this.options.issues.service.execute(resolved, context));
  }

  #mutationResult(source: AgentCommandSource, command: GarconIssueMutationCommand,
    result: Parameters<typeof issueMutationReceipt>[0]): GarconIssueResult {
    return parseIssueCommandResult({ ...identity(source, command), issueId: result.issue.id,
      status: 'ok', data: issueMutationReceipt(result) });
  }

  async #reply(source: AgentCommandSource, result: GarconIssueResult, signal: AbortSignal): Promise<void> {
    const content = garconIssueResultContent(result);
    const deliver = await this.options.chatMutationLock.runExclusive(`chat:${source.chatId}`, async () => {
      if (!this.#replies.current(source, signal)) return false;
      const detail = issueCommandOutcome(result);
      try {
        this.options.notices.appendNotice(source.chatId, source.viewId, {
          title: 'Issue command', content: issueCommandOutcomeContent(detail), detail,
          at: new Date().toISOString(),
        });
      } catch (error) { this.#replies.report(source, 'issue-outcome', error); }
      return true;
    });
    if (!deliver || signal.aborted) return;
    try {
      await this.options.execution.deliverServerControlInput(source.chatId, {
        content, transcriptViewId: source.viewId, createdAt: new Date().toISOString(), receipt: null,
      }, signal);
    } catch (error) {
      if (!signal.aborted) this.#replies.report(source, 'issue-result-delivery', error);
    }
  }
}

function identity(source: AgentCommandSource, command: GarconIssueCommand) {
  const payload = command.payload;
  const issueId = payload.action === 'list' || payload.action === 'create' ? undefined
    : 'query' in payload ? payload.query.issueId : payload.issueId;
  return { command: payload.action, ...(command.ref === undefined ? {} : { ref: command.ref }),
    ...(issueId === undefined ? {} : { issueId }), requestViewId: source.viewId, requestOrdinal: source.requestOrdinal };
}

function sourceUnavailable(): IssueDomainError {
  return new IssueDomainError('ISSUE_SOURCE_UNAVAILABLE', 'The source chat, transcript view, or captured project context is no longer available.');
}
