import type { ChatId } from '../../common/chat-id.js';
import type { GarconCreateChatParams } from '../../common/garcon-commands.js';
import type { JsonObject } from '../../common/json.js';
import type { LedgerRow, LedgerRowDraft } from './contracts.js';

export const CHAT_ID_REQUEST_NOTICE_TYPE = 'chat-id-request';
export const INTER_AGENT_SEND_REQUEST_NOTICE_TYPE = 'inter-agent-send-request';
export const SUB_AGENT_START_REQUEST_NOTICE_TYPE = 'sub-agent-start-request';

export interface InterAgentSendRequestLedgerDetail extends JsonObject {
  readonly type: typeof INTER_AGENT_SEND_REQUEST_NOTICE_TYPE;
  readonly recipients: readonly ChatId[];
  readonly hideSender: boolean;
  readonly body: string;
}

export interface SubAgentStartRequestParam extends JsonObject {
  readonly ref: string;
  readonly agentId: string;
  readonly providerId: string | null;
  readonly endpointId: string | null;
  readonly model: string;
  readonly reasoningEffort: string | null;
}

export interface SubAgentStartRequestLedgerDetail extends JsonObject {
  readonly type: typeof SUB_AGENT_START_REQUEST_NOTICE_TYPE;
  readonly prompt: string;
  readonly params: readonly SubAgentStartRequestParam[];
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

export function subAgentStartRequestNoticeDraft(
  at: string,
  detail: {
    readonly prompt: string;
    readonly params: readonly GarconCreateChatParams[];
  },
): LedgerRowDraft {
  return {
    kind: 'notice',
    at,
    message: 'Agent requested sub-agent creation',
    detail: {
      type: SUB_AGENT_START_REQUEST_NOTICE_TYPE,
      prompt: detail.prompt,
      params: detail.params.map((params): SubAgentStartRequestParam => ({ ...params })),
    },
    providerMeta: null,
  };
}

export function isLedgerPrivateGarconCommandRow(row: LedgerRow): boolean {
  return row.kind === 'notice'
    && (
      row.detail.type === CHAT_ID_REQUEST_NOTICE_TYPE
      || row.detail.type === INTER_AGENT_SEND_REQUEST_NOTICE_TYPE
      || row.detail.type === SUB_AGENT_START_REQUEST_NOTICE_TYPE
    );
}
