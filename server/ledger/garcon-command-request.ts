import type { ChatId } from '../../common/chat-id.js';
import type { JsonObject } from '../../common/json.js';
import type { LedgerRow, LedgerRowDraft } from './contracts.js';
import type { GarconStartAgentCommand } from '../../common/garcon-start-agent.js';
import type { GarconResumeAgentCommand } from '../../common/garcon-resume-agent.js';
import type { GarconScheduleCommand } from '../../common/garcon-schedule.js';

export const CHAT_ID_REQUEST_NOTICE_TYPE = 'chat-id-request';
export const INTER_AGENT_SEND_REQUEST_NOTICE_TYPE = 'inter-agent-send-request';
export const AGENT_START_REQUEST_NOTICE_TYPE = 'agent-start-request';
export const AGENT_RESUME_REQUEST_NOTICE_TYPE = 'agent-resume-request';
export const AGENT_SCHEDULE_REQUEST_NOTICE_TYPE = 'agent-schedule-request';

export function agentActionRequestNoticeDraft(at: string, command: GarconStartAgentCommand | GarconResumeAgentCommand | GarconScheduleCommand): LedgerRowDraft {
  return {
    kind: 'notice', at,
    message: command.type === 'start-agent' ? 'Agent requested child creation'
      : command.type === 'resume-agent' ? 'Agent requested child resume' : 'Agent requested prompt scheduling',
    detail: {
      type: command.type === 'start-agent' ? AGENT_START_REQUEST_NOTICE_TYPE
        : command.type === 'resume-agent' ? AGENT_RESUME_REQUEST_NOTICE_TYPE : AGENT_SCHEDULE_REQUEST_NOTICE_TYPE,
      command: command.type === 'schedule' ? { ...command, firstRun: { ...command.firstRun } } : { ...command },
    },
    providerMeta: null,
  };
}

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
      || row.detail.type === AGENT_START_REQUEST_NOTICE_TYPE
      || row.detail.type === AGENT_RESUME_REQUEST_NOTICE_TYPE
      || row.detail.type === AGENT_SCHEDULE_REQUEST_NOTICE_TYPE
    );
}
