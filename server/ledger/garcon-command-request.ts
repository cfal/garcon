import type { ChatId } from '../../common/chat-id.js';
import type { JsonObject } from '../../common/json.js';
import type { LedgerRow, LedgerRowDraft } from './contracts.js';
import type { GarconStartAgentCommand } from '../../common/garcon-start-agent.js';
import type { GarconResumeAgentCommand } from '../../common/garcon-resume-agent.js';
import type { GarconStopAgentCommand } from '../../common/garcon-stop-agent.js';
import type { GarconScheduleCommand } from '../../common/garcon-schedule.js';

export const CHAT_ID_REQUEST_NOTICE_TYPE = 'chat-id-request';
export const INTER_AGENT_SEND_REQUEST_NOTICE_TYPE = 'inter-agent-send-request';
export const AGENT_START_REQUEST_NOTICE_TYPE = 'agent-start-request';
export const AGENT_RESUME_REQUEST_NOTICE_TYPE = 'agent-resume-request';
export const AGENT_STOP_REQUEST_NOTICE_TYPE = 'agent-stop-request';
export const AGENT_SCHEDULE_REQUEST_NOTICE_TYPE = 'agent-schedule-request';

type AgentActionCommand = GarconStartAgentCommand | GarconResumeAgentCommand | GarconStopAgentCommand | GarconScheduleCommand;

const AGENT_ACTION_REQUEST_NOTICES = {
  'start-agent': { message: 'Agent requested child creation', type: AGENT_START_REQUEST_NOTICE_TYPE },
  'resume-agent': { message: 'Agent requested child resume', type: AGENT_RESUME_REQUEST_NOTICE_TYPE },
  'stop-agent': { message: 'Agent requested child stop', type: AGENT_STOP_REQUEST_NOTICE_TYPE },
  schedule: { message: 'Agent requested prompt scheduling', type: AGENT_SCHEDULE_REQUEST_NOTICE_TYPE },
} satisfies Record<AgentActionCommand['type'], { message: string; type: string }>;

export function agentActionRequestNoticeDraft(at: string, command: AgentActionCommand): LedgerRowDraft {
  const notice = AGENT_ACTION_REQUEST_NOTICES[command.type];
  return {
    kind: 'notice', at,
    message: notice.message,
    detail: {
      type: notice.type,
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
      || row.detail.type === AGENT_STOP_REQUEST_NOTICE_TYPE
      || row.detail.type === AGENT_SCHEDULE_REQUEST_NOTICE_TYPE
    );
}
