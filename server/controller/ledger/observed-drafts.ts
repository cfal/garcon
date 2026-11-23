import type { AgentProducedRow } from '@garcon/server-agent-interface';
import { AssistantMessage, UserMessage, isToolUseMessage, type ChatMessage } from '../../../common/chat-types.js';
import type { NativeChildNoticeDetail } from '../../../common/transcript-notice-details.js';
import { decodeLedgerRow, encodeLedgerDraft } from './codec.js';
import type { LedgerRowDraft } from './contracts.js';

export function observedDrafts(rows: readonly AgentProducedRow[]): { drafts: LedgerRowDraft[]; hadGap: boolean } {
  const drafts: LedgerRowDraft[] = [];
  let hadGap = false;
  for (const row of rows) {
    try {
      const message = observedMessage(row.message);
      if (!message) { hadGap = true; continue; }
      const draft: LedgerRowDraft = {
        kind: 'provider-row', at: message.timestamp, message, providerMeta: row.providerMeta ?? null,
      };
      // Validates an immutable snapshot before malformed provider data can fence storage.
      const encoded = encodeLedgerDraft(draft);
      const snapshot = decodeLedgerRow({
        view_id: 'observation-validation', ordinal: 1, kind: draft.kind, at: draft.at,
        client_message_id: encoded.clientMessageId, payload_json: encoded.payloadJson,
      });
      if (snapshot.kind !== 'provider-row') throw new TypeError('Invalid observed row');
      drafts.push({ kind: 'provider-row', at: snapshot.at, message: snapshot.message, providerMeta: snapshot.providerMeta });
    } catch {
      hadGap = true;
    }
  }
  return { drafts, hadGap };
}

export function observationNotice(detail: NativeChildNoticeDetail, at: string): LedgerRowDraft {
  const message = detail.type === 'native-child-gap'
    ? 'Some native subagent output was not captured. Reload retained history when the source is idle.'
    : detail.type === 'native-history-snapshot'
      ? 'Native history snapshot. Live capture has ended.'
      : `Native subagent ${detail.status}.`;
  return { kind: 'notice', at, message, detail: { ...detail }, providerMeta: null };
}

function observedMessage(message: ChatMessage): ChatMessage | null {
  if (isToolUseMessage(message)) return message;
  switch (message.type) {
    case 'user-message': return new UserMessage(message.timestamp, message.content, message.images);
    case 'assistant-message': return new AssistantMessage(message.timestamp, message.content);
    case 'thinking':
    case 'tool-result':
    case 'error':
    case 'compaction': return message;
    case 'command-output':
    case 'command-result':
    case 'permission-request':
    case 'permission-resolved':
    case 'permission-cancelled':
    case 'permission-expired':
    case 'agent-switch':
    case 'cli-row':
    case 'transcript-notice': return null;
    default: return unsupportedMessage(message);
  }
}

function unsupportedMessage(_message: never): never {
  throw new TypeError('Unsupported observed message');
}
