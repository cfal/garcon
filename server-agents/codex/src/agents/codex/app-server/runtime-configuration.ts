import { AgentIntegrationError, type AgentSessionConfigurationPrepareRequest } from '@garcon/server-agent-interface';
import { SessionConfigurationPreparations } from '@garcon/server-agent-common/execution/session-configuration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { CodexAppServerClient } from './client.js';
import type { RunningCodexSession } from './runtime-session-state.js';
import { isActiveSessionStatus } from './runtime-support.js';
import { buildThreadSettingsUpdateParams, codexThreadSettingsTarget, threadSettingsMatch, type CodexThreadSettingsTarget } from './request-builders.js';

interface CodexSessionConfigurationOptions {
  sourceForChat(chatId: string): RunningCodexSession | undefined;
  sourceForClient(client: CodexAppServerClient): RunningCodexSession | undefined;
  sourceForThread(threadId: string): RunningCodexSession | null;
  timeoutMs(): number;
}

export class CodexSessionConfigurationController {
  constructor(private readonly options: CodexSessionConfigurationOptions) {}

  readonly updates = new SessionConfigurationPreparations((request) => this.#captureConfiguration(request));

  #captureConfiguration(request: AgentSessionConfigurationPrepareRequest) {
    const { expected, previous, next } = request;
    const source = this.options.sourceForChat(expected.chatId);
    const session = source?.threadId === expected.agentSessionId && !source.superseded ? source : null;
    const conflict = { kind: 'rejected', reason: 'target-conflict' } as const;
    if (!session) return source || this.options.sourceForThread(expected.agentSessionId) ? conflict : null;
    if (session.projectPath !== expected.projectPath || !expected.nativeSession) return conflict;
    try {
      const native = createPathNativeSessionCodec('codex').decode(expected.nativeSession);
      if (native.agentSessionId !== session.threadId || native.modelEndpointId !== session.nativeModelEndpointId
        || native.path !== session.publishedNativePath && native.path !== session.nativePath) return conflict;
    } catch { return conflict; }
    const epoch = session.configurationEpoch;
    const turnGeneration = session.turnAttemptGeneration;
    const activeTurnId = session.activeTurnId;
    const active = isActiveSessionStatus(session.status);
    const target = codexThreadSettingsTarget(next);
    const clearsEffort = codexThreadSettingsTarget(previous).effort !== null && target.effort === null;
    const changesEndpoint = next.endpoint?.apiProviderId !== previous.endpoint?.apiProviderId
      || next.endpoint?.endpointId !== previous.endpoint?.endpointId || next.endpoint?.protocol !== previous.endpoint?.protocol;
    if (active && (clearsEffort || changesEndpoint)) {
      throw new AgentIntegrationError(clearsEffort ? 'INVALID_SETTINGS' : 'INVALID_ENDPOINT', clearsEffort
        ? 'Codex cannot clear a concrete reasoning effort during an active turn'
        : 'Cannot change the Codex endpoint while a session is running', false);
    }
    return {
      validate: () => this.options.sourceForChat(expected.chatId) === session && this.options.sourceForClient(session.client) === session
        && !session.superseded && !session.configurationFenced && !session.configurationPreparing
        && session.configurationEpoch === epoch && session.turnAttemptGeneration === turnGeneration
        && session.activeTurnId === activeTurnId && (!active || activeTurnId !== null)
        && session.projectPath === expected.projectPath && session.chatId === expected.chatId,
      deliver: async (beforeMutation: () => void) => {
        if (clearsEffort || changesEndpoint) return 'not-required' as const;
        const update = session.threadSettingsUpdateChain.then(() => this.applyThreadSettings(session, target, beforeMutation));
        session.threadSettingsUpdateChain = update.catch(() => undefined);
        await update;
        return 'applied' as const;
      },
    };
  }

  async applyThreadSettings(
    session: RunningCodexSession,
    target: CodexThreadSettingsTarget,
    beforeMutation: () => void = () => {},
  ): Promise<void> {
    beforeMutation();
    if (this.options.sourceForClient(session.client) !== session) throw new Error('Codex configuration source retired');
    if (session.configurationFenced) {
      throw new AgentIntegrationError(
        'INVALID_SETTINGS',
        'Codex settings are fenced after an ambiguous update',
        false,
      );
    }
    // Explicit intent precedes a confirmation that can arrive before the RPC response.
    if (target.effort !== null) session.providerOwnsReasoningEffort = false;
    if (threadSettingsMatch(session.confirmedThreadSettings, target)) {
      session.permissionMode = target.permissionMode;
      return;
    }

    let resolveConfirmation!: () => void;
    let rejectConfirmation!: (error: Error) => void;
    const confirmation = new Promise<void>((resolve, reject) => {
      resolveConfirmation = resolve;
      rejectConfirmation = reject;
    });
    const waiter = {
      target,
      timeout: setTimeout(() => {
        if (session.pendingThreadSettings !== waiter) return;
        session.pendingThreadSettings = null;
        session.configurationFenced = true;
        rejectConfirmation(new AgentIntegrationError(
          'TIMEOUT',
          'Codex thread settings confirmation timed out; automatic turns are fenced',
          false,
        ));
      }, this.options.timeoutMs()),
      resolve: resolveConfirmation,
      reject: rejectConfirmation,
    };
    session.pendingThreadSettings = waiter;
    try {
      const settled = await Promise.allSettled([
        session.client.updateThreadSettings(
          buildThreadSettingsUpdateParams(session.threadId, target),
        ).catch((error) => { rejectConfirmation(error); throw error; }),
        confirmation,
      ]);
      for (const result of settled) if (result.status === 'rejected') throw result.reason;
    } finally {
      if (session.pendingThreadSettings === waiter) {
        clearTimeout(waiter.timeout);
        session.pendingThreadSettings = null;
      }
    }
  }

}
