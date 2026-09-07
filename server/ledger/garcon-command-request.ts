import type { ChatId } from '../../common/chat-id.js';
import type { JsonObject } from '../../common/json.js';
import type { LedgerRow, LedgerRowDraft } from './contracts.js';

export const CHAT_ID_REQUEST_NOTICE_TYPE = 'chat-id-request';
export const INTER_AGENT_SEND_REQUEST_NOTICE_TYPE = 'inter-agent-send-request';

export interface InterAgentSendRequestLedgerDetail extends JsonObject {
  readonly type: typeof INTER_AGENT_SEND_REQUEST_NOTICE_TYPE;
  readonly recipients: readonly ChatId[];
  readonly hideSender: boolean;
  readonly body: string;
}

export function chatIdRequestNoticeDraft(at: string): LedgerRowDraft {
  return {
    kind: 'notice',
    at,
    message: 'Agent requested chat ID',
    detail: { type: CHAT_ID_REQUEST_NOTICE_TYPE },
    providerMeta: null,
  };
}

export function interAgentSendRequestNoticeDraft(
  at: string,
  detail: Omit<InterAgentSendRequestLedgerDetail, 'type'>,
): LedgerRowDraft {
  return {
    kind: 'notice',
    at,
    message: 'Agent requested inter-agent message delivery',
    detail: { type: INTER_AGENT_SEND_REQUEST_NOTICE_TYPE, ...detail },
    providerMeta: null,
  };
}

export function isLedgerPrivateGarconCommandRow(row: LedgerRow): boolean {
  return row.kind === 'notice'
    && (
      row.detail.type === CHAT_ID_REQUEST_NOTICE_TYPE
      || row.detail.type === INTER_AGENT_SEND_REQUEST_NOTICE_TYPE
    );
}
