import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AgentSessionConfigurationPrepareRequest } from '@garcon/server-agent-interface';
import { SessionConfigurationNotDeliveredError, SessionConfigurationPreparations } from '@garcon/server-agent-common/execution/session-configuration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { providerStartupPermissionMode } from '@garcon/server-agent-common/execution/permission-modes';
import type { ClaudeControlBroker } from './cli-control.js';
import type { ClaudeRunningSession } from './runtime-state.js';
import type { ClaudeProjectPathUpdate } from './runtime-types.js';

interface ClaudeSessionConfigurationOptions {
  readonly sessions: ReadonlyMap<string, ClaudeRunningSession>;
  readonly controls: Pick<ClaudeControlBroker, 'request'>;
  readonly controlTimeoutMs?: number;
  shuttingDown(): boolean;
  hasPendingPermission(agentSessionId: string): boolean;
  removeSession(agentSessionId: string): void;
  retireProcess(session: ClaudeRunningSession): Promise<void>;
  waitForRetirement(agentSessionId: string, chatId: string): Promise<void>;
}

export class ClaudeSessionConfigurationController {
  constructor(private readonly options: ClaudeSessionConfigurationOptions) {}

  async prepareProjectPathUpdate(request: ClaudeProjectPathUpdate): Promise<void> {
    const agentSessionId = request.agentSessionId;
    if (!agentSessionId) return;

    const session = this.options.sessions.get(agentSessionId);
    if (session && session.chatId !== request.chatId) {
      throw new Error('Chat ID mismatch');
    }
    if (session && session.options.projectPath !== request.previousProjectPath) {
      throw new Error('Project path mismatch');
    }
    if (session?.configurationPreparing) throw new Error('Claude session is already preparing a turn');
    if (session?.activeTurn) {
      throw new Error('Cannot update project path while Claude is running');
    }
    if (this.options.hasPendingPermission(agentSessionId)) {
      throw new Error('Cannot update project path while Claude is waiting for permission');
    }

    const preparation = Object.freeze({});
    if (session) session.configurationPreparing = preparation;
    try {
      if (session) {
        session.configurationEpoch += 1;
        await this.options.retireProcess(session);
      }
      await this.options.waitForRetirement(agentSessionId, request.chatId);
      if (session && this.options.sessions.get(agentSessionId) === session) this.options.removeSession(agentSessionId);
    } finally {
      if (session?.configurationPreparing === preparation) session.configurationPreparing = null;
    }
  }

  readonly updates = new SessionConfigurationPreparations((request) => this.#captureConfiguration(request));

  #captureConfiguration(request: AgentSessionConfigurationPrepareRequest) {
    const { expected, next } = request;
    const session = this.options.sessions.get(expected.agentSessionId);
    if (!session) return null;
    const conflict = { kind: 'rejected', reason: 'target-conflict' } as const;
    if (session.chatId !== expected.chatId || session.options.projectPath !== expected.projectPath || !expected.nativeSession) return conflict;
    try {
      const native = createPathNativeSessionCodec('claude').decode(expected.nativeSession);
      if (native.agentSessionId !== session.id || native.path !== session.nativePath
        || native.modelEndpointId !== session.nativeModelEndpointId) return conflict;
    } catch { return conflict; }
    const epoch = session.configurationEpoch;
    const activeTurn = session.activeTurn;
    const process = session.process;
    const transport = session.transport;
    return {
      validate: () => !this.options.shuttingDown() && this.options.sessions.get(session.id) === session
        && !session.initialization && !session.configurationPreparing && !session.retirement
        && session.configurationEpoch === epoch && session.activeTurn === activeTurn
        && (!activeTurn || activeTurn.protocol.inputStarted && !activeTurn.protocol.abortRequested)
        && session.process === process && session.transport === transport
        && session.chatId === expected.chatId && session.options.projectPath === expected.projectPath,
      deliver: async (beforeMutation: () => void) => {
        const update = session.configurationUpdateChain.then(async () => {
          const thinking = next.settings.values.claudeThinkingMode;
          const claudeThinkingMode = thinking === 'on' || thinking === 'off' ? thinking : 'auto';
          const applyOptions = () => {
            beforeMutation();
            session.options = { ...session.options, model: next.model, permissionMode: next.permissionMode,
              thinkingMode: next.thinkingMode, claudeThinkingMode };
          };
          const retireIdle = !activeTurn && process && (
            next.thinkingMode !== session.currentThinkingMode || claudeThinkingMode !== session.currentClaudeThinkingMode
            || !session.permissionModeConfirmed
            || providerStartupPermissionMode(next.permissionMode) !== providerStartupPermissionMode(session.currentPermissionMode)
              && (next.permissionMode === 'bypassPermissions' || session.currentPermissionMode === 'bypassPermissions')
          );
          if (!retireIdle && (!transport
            || session.permissionModeConfirmed && session.currentPermissionMode === next.permissionMode)) {
            return 'not-required' as const;
          }
          if (retireIdle) {
            applyOptions();
            session.currentPermissionMode = next.permissionMode;
            await this.options.retireProcess(session);
          } else {
            let deliveryBegan = false;
            try {
              await this.setPermissionMode(session, next.permissionMode, () => { deliveryBegan = true; applyOptions(); });
            } catch (error) {
              if (!deliveryBegan) throw new SessionConfigurationNotDeliveredError('target-changed', { cause: error });
              throw error;
            }
          }
          return 'applied' as const;
        });
        session.configurationUpdateChain = update.then(() => undefined, () => undefined);
        return update;
      },
    };
  }

  async setPermissionMode(session: ClaudeRunningSession, mode: PermissionMode, beforeWrite: () => void): Promise<void> {
    const transport = session.transport;
    const epoch = session.configurationEpoch;
    const apply = () => {
      beforeWrite();
      if (this.options.sessions.get(session.id) !== session || session.transport !== transport || session.configurationEpoch !== epoch) {
        throw new Error('Claude session changed while applying permission mode');
      }
      session.currentPermissionMode = mode;
      session.options = { ...session.options, permissionMode: mode };
    };
    if (!transport || session.permissionModeConfirmed && session.currentPermissionMode === mode) {
      apply();
      return;
    }
    await this.options.controls.request(session.id, {
      subtype: 'set_permission_mode', mode: providerStartupPermissionMode(mode),
    }, {
      timeoutMs: this.options.controlTimeoutMs,
      beforeWrite: () => {
        apply();
        session.permissionModeConfirmed = false;
      },
    });
    if (session.transport === transport && session.currentPermissionMode === mode) {
      session.permissionModeConfirmed = true;
    }
  }

}
