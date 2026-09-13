import type { AgentLogger } from '@garcon/server-agent-interface';
import type { ClaudeControlBroker } from './cli-control.js';
import { updateClaudeContextWindow } from './context-window-control.js';
import { resolveClaudeModel } from './model-context.js';
import type { ClaudeRunningSession } from './runtime-state.js';
import { assertClaudeExecutionOpen, type ClaudeExecutionAdmission } from './runtime-types.js';

interface ClaudeSessionModelOptions {
  readonly executionAdmission?: ClaudeExecutionAdmission;
  readonly controlBroker: Pick<ClaudeControlBroker, 'request'>;
  readonly logger: AgentLogger;
  isCurrentSession(): boolean;
  retireProcess(): Promise<void>;
  resumeProcess(): Promise<unknown>;
}

export async function configureClaudeSessionModel(
  session: ClaudeRunningSession,
  desiredModel: string,
  options: ClaudeSessionModelOptions,
): Promise<void> {
  const current = resolveClaudeModel(session.currentModel);
  const desired = resolveClaudeModel(desiredModel);
  if (session.process && current.autoCompactWindow !== desired.autoCompactWindow) {
    // Clearing a live env cap exposes the captured startup cap, not necessarily automatic
    // policy. Transitions into or out of automatic policy still use a fresh process.
    if (current.autoCompactWindow === null || desired.autoCompactWindow === null) {
      await options.retireProcess();
    } else {
      const contextUpdated = await tryUpdateContextWindow(
        session, current.model, desired.model, desired.autoCompactWindow, options,
      );
      if (contextUpdated) session.currentModel = desiredModel;
    }
  }

  if (!session.process) {
    // The native transcript owns conversation context, including after a failed live update.
    assertCurrentSession(options);
    await options.resumeProcess();
  }
  if (session.process && desiredModel !== session.currentModel) {
    await options.controlBroker.request(session.id, { subtype: 'set_model', model: desired.model });
  }
  session.currentModel = desiredModel;
}

async function tryUpdateContextWindow(
  session: ClaudeRunningSession,
  currentModel: string,
  desiredModel: string,
  autoCompactWindow: number,
  options: ClaudeSessionModelOptions,
): Promise<boolean> {
  const process = session.process;
  let controlSubtype = 'get_settings';
  const assertCurrentProcess = () => {
    assertCurrentSession(options);
    if (session.process !== process || session.activeTurn !== null) {
      throw new Error('Claude process changed during context-window configuration');
    }
  };
  try {
    await updateClaudeContextWindow(async request => {
      assertCurrentProcess();
      controlSubtype = request.subtype;
      const response = await options.controlBroker.request(session.id, request, {
        signal: options.executionAdmission?.signal,
      });
      assertCurrentProcess();
      return response;
    }, currentModel, desiredModel, autoCompactWindow);
    assertCurrentProcess();
    options.logger.info('Claude context window updated without restarting', {
      chatId: session.chatId,
      sessionId: session.id.slice(0, 8),
      processId: process?.pid ?? null,
      model: desiredModel,
      autoCompactWindow,
    });
    return true;
  } catch {
    // Settings and CLI errors may contain credentials. Only the failed operation is logged.
    options.logger.warn('Claude context-window update failed; resuming with startup settings', {
      chatId: session.chatId,
      sessionId: session.id.slice(0, 8),
      processId: process?.pid ?? null,
      controlSubtype,
    });
    if (options.isCurrentSession() && session.process === process) {
      await options.retireProcess();
    }
    assertCurrentSession(options);
    return false;
  }
}

function assertCurrentSession(options: ClaudeSessionModelOptions): void {
  assertClaudeExecutionOpen(options);
  if (!options.isCurrentSession()) {
    throw new Error('Claude session ended during model configuration');
  }
}
