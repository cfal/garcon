import { CommandOutputMessage, CommandResultMessage, UserMessage } from '@garcon/common/chat-types';
import type { CommandOutcome } from '@garcon/common/command-output';
import {
  AgentCallError, AgentIntegrationError, createAgentResourceRef, type AgentExecutionHandle, type AgentHost,
  type AgentIntegration, type AgentProducerNotification, type AgentProducerBinding,
  type AgentStartRequestV5, type AgentResumeRequestV5, type ExecutorCallOptions, type AgentRunEndedEvent,
} from '@garcon/server-agent-interface';
import { AgentResourceTable } from '@garcon/server-agent-common/execution/resource-table';
import { failureDetail } from '@garcon/server-agent-common/execution/producer-adapter';
import { requireShell } from './catalog.js';
import { executeShell } from './process.js';
import { parseSubmission } from './source.js';
import { CommandOutputTail } from './output.js';
import { ShellNativeStore, type NativeLog } from './native-store.js';

interface Binding {
  ref: AgentProducerBinding;
  chatId: string;
  closed: boolean;
  detached: boolean;
}

interface Invocation {
  binding: Binding;
  sessionId: string;
  startedAt: string;
  cancellation: AbortController;
  settled: Promise<void>;
  handle: AgentExecutionHandle;
}

export class ShellExecution {
  readonly execution: AgentIntegration['execution'];
  readonly producers: AgentIntegration['producers'];
  readonly permissions: AgentIntegration['permissions'] = {
    async respond() { throw new AgentCallError('rejected', 'Shell has no permission requests', 'STALE_RESOURCE'); },
  };
  readonly #bindings;
  readonly #handles;
  readonly #listeners = new Set<(event: AgentProducerNotification) => void>();
  readonly #active = new Map<string, Invocation>();
  readonly #nativeReaders = new Set<string>();

  constructor(private readonly host: AgentHost, readonly store: ShellNativeStore) {
    this.#bindings = new AgentResourceTable<'producer', Binding>(host.scope, 'producer', Infinity);
    this.#handles = new AgentResourceTable<'execution', Invocation>(host.scope, 'execution');
    this.execution = {
      start: (request, options) => this.#launch(request, options),
      resume: (request, options) => this.#launch(request, options),
      abort: async (handle) => {
        const invocation = this.#handles.get(handle);
        invocation.cancellation.abort();
        await invocation.settled;
        return true;
      },
      runningSessions: async () => [...this.#active.values()].map(invocation => ({
        agentSessionId: invocation.sessionId, startedAt: invocation.startedAt, status: 'running',
      })),
    };
    this.producers = {
      scope: host.scope,
      bind: async ({ binding, chatId }) => {
        this.#bindings.bind(binding, { ref: binding, chatId, closed: false, detached: false });
      },
      close: async (ref) => {
        const binding = this.#bindings.get(ref);
        binding.closed = true;
        this.#bindings.delete(ref);
        const invocation = this.#active.get(binding.chatId);
        if (invocation?.binding === binding) {
          invocation.cancellation.abort();
          await invocation.settled;
        }
      },
      detach: (ref) => {
        let binding: Binding;
        try {
          binding = this.#bindings.get(ref);
        } catch {
          return;
        }
        binding.detached = true;
        if (this.#active.get(binding.chatId)?.binding !== binding) this.#bindings.delete(ref);
      },
      subscribe: listener => {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
      },
    };
  }

  #emit(binding: Binding, event: AgentProducerNotification['event']): void {
    if (binding.closed || binding.detached) return;
    for (const listener of this.#listeners) {
      try {
        listener({ binding: binding.ref, event });
      } catch (error) {
        this.host.logger.warn('Shell transcript publication failed; native history retained', { reason: String(error) });
      }
    }
  }

  async #launch(request: AgentStartRequestV5 | AgentResumeRequestV5, options?: ExecutorCallOptions): Promise<AgentExecutionHandle> {
    options?.signal?.throwIfAborted();
    if (request.attachments.length || request.endpoint || ('carriedContext' in request && request.carriedContext !== null)) {
      throw new AgentIntegrationError('INVALID_SETTINGS', 'Shell accepts only the explicitly submitted command.', false);
    }
    const active = this.#active.get(request.chatId);
    if (active?.cancellation.signal.aborted) await active.settled;
    options?.signal?.throwIfAborted();
    const binding = this.#bindings.get(request.producerBinding);
    if (binding.closed || binding.detached || binding.chatId !== request.chatId) {
      throw new AgentCallError('rejected', 'Producer binding is unavailable', 'STALE_RESOURCE');
    }
    if (this.#active.has(request.chatId) || this.#nativeReaders.has(request.chatId)) throw busy();
    const parsed = parseSubmission(request.prompt);
    const shell = requireShell(this.host, request.model);
    const sessionId = 'nativeSession' in request
      ? this.store.sessionId(request.nativeSession, request.agentSessionId) : crypto.randomUUID();
    const invocation: Invocation = {
      binding, sessionId, startedAt: new Date().toISOString(), cancellation: new AbortController(),
      settled: Promise.resolve(), handle: createAgentResourceRef(this.host.scope, 'execution'),
    };
    this.#handles.bind(invocation.handle, invocation);
    this.#active.set(request.chatId, invocation);
    const cancelAdmission = () => invocation.cancellation.abort();
    options?.signal?.addEventListener('abort', cancelAdmission, { once: true });
    invocation.settled = this.#run(invocation, request, parsed, shell)
      .catch((error): AgentRunEndedEvent => ({ type: 'run-ended', runId: request.runId, outcome: 'failed', error: failureDetail(error) }))
      .then(terminal => {
        options?.signal?.removeEventListener('abort', cancelAdmission);
        if (this.#active.get(request.chatId) === invocation) this.#active.delete(request.chatId);
        this.#handles.delete(invocation.handle);
        this.#emit(binding, terminal);
        if (binding.detached) this.#bindings.delete(binding.ref);
      });
    return invocation.handle;
  }

  async #run(
    invocation: Invocation,
    request: AgentStartRequestV5 | AgentResumeRequestV5,
    parsed: ReturnType<typeof parseSubmission>,
    shell: ReturnType<typeof requireShell>,
  ): Promise<AgentRunEndedEvent> {
    const commandId = crypto.randomUUID();
    let log: NativeLog | undefined;
    let commandRecorded = false;
    const output = new CommandOutputTail();
    let outputPublished = false;
    const publishOutput = () => {
      if (outputPublished) return;
      outputPublished = true;
      for (const message of output.messages()) {
        log!.append(commandId, message);
        this.#emit(invocation.binding, { type: 'rows', rows: [{ message }] });
      }
    };
    try {
      const commandLog = 'nativeSession' in request
        ? await this.store.load(invocation.sessionId, request.chatId)
        : await this.store.create(invocation.sessionId, request.chatId);
      log = commandLog;
      commandLog.reconcile();
      invocation.cancellation.signal.throwIfAborted();
      this.#emit(invocation.binding, {
        type: 'session',
        session: {
          agentSessionId: invocation.sessionId,
          nativeSession: this.store.reference(invocation.sessionId),
          nativeSeedReceipt: null,
        },
      });
      const input = new UserMessage(request.submission?.timestamp ?? invocation.startedAt, request.prompt, undefined, {
        contentMode: 'literal',
        ...(request.submission?.clientMessageId ? { clientMessageId: request.submission.clientMessageId } : {}),
      });
      commandLog.append(commandId, input, {
        ...parsed,
        family: shell.family,
        executable: shell.executable,
        projectPath: request.projectPath,
        executorId: this.host.scope.executorId,
      });
      commandRecorded = true;
      const offsets = { stdout: 0, stderr: 0 };
      this.#emit(invocation.binding, { type: 'started', runId: request.runId });
      const result = await executeShell({
        ...shell, source: parsed.source, cwd: request.projectPath, temporaryRoot: await this.store.directory(),
        signal: invocation.cancellation.signal,
        output: (channel, content) => {
          const message = new CommandOutputMessage(new Date().toISOString(), commandId, channel,
            channel === 'stdout' ? parsed.format : 'plain', content,
            { executorId: this.host.scope.executorId, projectPath: request.projectPath }, offsets[channel]);
          offsets[channel] += content.length;
          output.append(message);
        },
      });
      let status: CommandOutcome['outcome'] = 'failed';
      if (result.interrupted) {
        status = 'interrupted';
      } else if (result.exitCode === 0 && result.complete && result.cwd.kind !== 'invalid') {
        status = 'finished';
      }
      let capture: CommandOutcome['capture'] = 'complete';
      if (!result.complete) capture = 'incomplete';
      else if (output.truncated) capture = 'truncated';
      const outcome: CommandOutcome = {
        outcome: status,
        exitCode: result.exitCode,
        signal: result.signal,
        cwd: result.cwd.kind === 'invalid' ? { kind: 'unavailable', reason: result.cwd.reason } : result.cwd,
        capture,
      };
      const message = new CommandResultMessage(new Date().toISOString(), commandId, outcome);
      publishOutput();
      commandLog.append(commandId, message);
      this.#emit(invocation.binding, { type: 'rows', rows: [{ message }] });
      const terminal = { type: 'run-ended', runId: request.runId, workingDirectory: outcome.cwd } as const;
      if (outcome.outcome === 'finished') {
        let text = output.messages().find(message => message.channel === 'stdout')?.content ?? '';
        if (output.truncated) {
          text = `[Output truncated to the last 64 KiB across stdout and stderr]\n${text}`;
        }
        return {
          ...terminal,
          outcome: 'finished',
          finalResponse: { type: 'literal-text', text },
        };
      }
      if (outcome.outcome === 'interrupted') return { ...terminal, outcome: 'interrupted' };
      const failure = result.cwd.kind === 'invalid'
        ? `Process exited ${result.exitCode ?? 'without an exit code'}. ${result.cwd.reason}`
        : message.content;
      return { ...terminal, outcome: 'failed', error: { code: 'PROVIDER_FAILURE', message: failure } };
    } catch (error) {
      publishOutput();
      if (log && commandRecorded) {
        const message = new CommandResultMessage(new Date().toISOString(), commandId, {
          outcome: invocation.cancellation.signal.aborted ? 'interrupted' : 'failed', exitCode: null, signal: null,
          capture: 'incomplete', cwd: { kind: 'unavailable', reason: String(error).slice(0, 1024) },
        });
        try {
          log.append(commandId, message);
          this.#emit(invocation.binding, { type: 'rows', rows: [{ message }] });
        } catch (failure) {
          this.host.logger.error('Shell native history is incomplete', { reason: String(failure) });
        }
      }
      return invocation.cancellation.signal.aborted
        ? { type: 'run-ended', runId: request.runId, outcome: 'interrupted' }
        : { type: 'run-ended', runId: request.runId, outcome: 'failed', error: failureDetail(error) };
    } finally {
      log?.close();
    }
  }

  async *history(chatId: string, sessionId: string, signal: AbortSignal) {
    if (this.#active.has(chatId) || this.#nativeReaders.has(chatId)) throw busy();
    this.#nativeReaders.add(chatId);
    let log: NativeLog | undefined;
    try {
      log = await this.store.load(sessionId, chatId);
      log.reconcile();
      yield* log.messages(signal);
    } finally {
      log?.close();
      this.#nativeReaders.delete(chatId);
    }
  }

  async release(chatId: string, sessionId: string): Promise<void> {
    const invocation = this.#active.get(chatId);
    if (invocation?.sessionId === sessionId) {
      invocation.cancellation.abort();
      await invocation.settled;
    }
    if (this.#nativeReaders.has(chatId)) throw busy();
    await this.store.remove(sessionId);
  }

  async stop(): Promise<void> {
    const active = [...this.#active.values()];
    for (const invocation of active) invocation.cancellation.abort();
    await Promise.all(active.map(invocation => invocation.settled));
    this.#bindings.clear();
    this.#listeners.clear();
  }
}

function busy(): AgentIntegrationError {
  return new AgentIntegrationError('SESSION_BUSY', 'The previous shell invocation or native import has not settled.', true);
}
