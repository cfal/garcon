import {
  AgentCallError,
  AgentIntegrationError,
  type AgentProjectPathUpdatePreparation,
  type AgentProjectPathUpdateRequest,
  type AgentProjectPathUpdates,
  type AgentResourceScope,
} from '@garcon/server-agent-interface';
import { AgentResourceTable } from './resource-table.js';

export function createAgentProjectPathUpdates(
  scope: AgentResourceScope,
  prepare: (request: AgentProjectPathUpdateRequest) => Promise<AgentProjectPathUpdatePreparation | void>,
): AgentProjectPathUpdates {
  const blockedChats = new Set<string>();
  const preparations = new AgentResourceTable<'project-path-preparation', {
    readonly chatId: string;
    value: AgentProjectPathUpdatePreparation | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>(scope, 'project-path-preparation', 64);

  return {
    async prepare(request, options) {
      options?.signal?.throwIfAborted();
      const chatId = request.chat.chatId;
      if (blockedChats.has(chatId)) throw new AgentCallError('rejected', 'Project path decision requires reconciliation', 'SESSION_BUSY');
      if (blockedChats.size >= 64) throw new AgentCallError('not-dispatched', 'Project path preparation budget exhausted', 'SESSION_BUSY');
      const preparation = {
        chatId,
        value: null as AgentProjectPathUpdatePreparation | null,
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      const ref = preparations.add(preparation);
      blockedChats.add(chatId);
      let value: AgentProjectPathUpdatePreparation | void;
      try {
        value = await prepare({ ...request, signal: options?.signal ?? new AbortController().signal });
      } catch (error) {
        preparations.delete(ref);
        if (isDefinitiveRefusal(error)) blockedChats.delete(chatId);
        throw error;
      }
      if (!value) {
        preparations.delete(ref);
        blockedChats.delete(chatId);
        return null;
      }
      preparation.value = value;
      // Expiry cannot undo a controller decision whose acknowledgement was lost.
      preparation.timer = setTimeout(() => preparations.delete(ref), 30_000);
      preparation.timer.unref();
      return { preparation: ref, ...(value.nativeSession === undefined ? {} : { nativeSession: value.nativeSession }) };
    },
    async commit(ref, options) {
      options?.signal?.throwIfAborted();
      const preparation = preparations.take(ref);
      if (preparation.timer) clearTimeout(preparation.timer);
      await preparation.value!.commit();
      blockedChats.delete(preparation.chatId);
    },
    async rollback(ref, options) {
      options?.signal?.throwIfAborted();
      const preparation = preparations.take(ref);
      if (preparation.timer) clearTimeout(preparation.timer);
      await preparation.value!.rollback();
      blockedChats.delete(preparation.chatId);
    },
  };
}

function isDefinitiveRefusal(error: unknown): boolean {
  if (error instanceof AgentCallError) return error.outcome !== 'unknown';
  if (!(error instanceof AgentIntegrationError)) return false;
  switch (error.code) {
    case 'SESSION_BUSY':
    case 'SESSION_NOT_FOUND':
    case 'OPERATION_UNSUPPORTED':
    case 'TRANSCRIPT_UNAVAILABLE':
    case 'PROJECT_PATH_DESTINATION_REJECTED':
      return true;
    default:
      return false;
  }
}
