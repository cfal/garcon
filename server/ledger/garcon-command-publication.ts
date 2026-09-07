import type { AgentProducedRow } from '@garcon/server-agent-interface';
import type { ChatId } from '../../common/chat-id.js';
import {
  extractGarconCommands,
  INTER_AGENT_MESSAGE_NOTICE_TITLE,
  MALFORMED_INTER_AGENT_MESSAGE_CONTENT,
  type GarconEdgeCommand,
} from '../../common/garcon-commands.js';
import type { LedgerRow, LedgerRowDraft, TranscriptViewId } from './contracts.js';
import type { GarconStartAgentCommand } from '../../common/garcon-start-agent.js';
import type { GarconScheduleCommand } from '../../common/garcon-schedule.js';
import {
  chatIdRequestNoticeDraft,
  agentActionRequestNoticeDraft,
  interAgentSendRequestNoticeDraft,
} from './garcon-command-request.js';

export interface ChatIdRequestSink {
  request(input: {
    readonly chatId: string;
    readonly viewId: TranscriptViewId;
    readonly runId: string | null;
    readonly at: string;
  }): void;
}

export interface AgentCommandSource {
  readonly chatId: string;
  readonly viewId: TranscriptViewId;
  readonly requestOrdinal: number;
  readonly runId: string | null;
  readonly at: string;
}

export interface AgentStartRequestSink {
  request(source: AgentCommandSource, command: GarconStartAgentCommand): void;
}

export interface AgentScheduleRequestSink {
  request(source: AgentCommandSource, command: GarconScheduleCommand): void;
}

export interface InterAgentMessageRequestSink {
  request(input: {
    readonly sourceChatId: string;
    readonly sourceViewId: TranscriptViewId;
    readonly requestAt: string;
    readonly recipients: readonly ChatId[];
    readonly hideSender: boolean;
    readonly body: string;
  }): void;
}

export const DISABLED_CHAT_ID_REQUEST_SINK: ChatIdRequestSink = Object.freeze({
  request: () => undefined,
});

export const DISABLED_INTER_AGENT_MESSAGE_SINK: InterAgentMessageRequestSink = Object.freeze({
  request: () => undefined,
});

interface PendingGarconCommand {
  readonly command: GarconEdgeCommand;
  readonly at: string;
  readonly requestDraftIndex: number;
}

export function canonicalizeGarconProducerRows(rows: readonly AgentProducedRow[]): {
  readonly drafts: readonly LedgerRowDraft[];
  readonly commands: readonly PendingGarconCommand[];
} {
  const drafts: LedgerRowDraft[] = [];
  const commands: PendingGarconCommand[] = [];
  for (const row of rows) {
    const transformed = extractGarconCommands(row.message);
    const message = transformed ? transformed.message : row.message;
    if (message) {
      drafts.push({
        kind: 'provider-row',
        at: message.timestamp,
        message,
        providerMeta: row.providerMeta ?? null,
      });
    }
    if (!transformed) continue;
    for (const command of transformed.commands) {
      commands.push({ command, at: row.message.timestamp, requestDraftIndex: drafts.length });
      switch (command.type) {
        case 'start-agent':
        case 'schedule':
          drafts.push(agentActionRequestNoticeDraft(row.message.timestamp, command));
          break;
        case 'get-chat-id':
          drafts.push(chatIdRequestNoticeDraft(row.message.timestamp));
          break;
        case 'send-message':
          drafts.push(interAgentSendRequestNoticeDraft(row.message.timestamp, {
            recipients: command.recipients,
            hideSender: command.hideSender,
            body: command.body,
          }));
          break;
      }
    }
    for (const issue of transformed.issues) {
      drafts.push({
        kind: 'notice',
        at: row.message.timestamp,
        message: issue.command === 'send-message' ? MALFORMED_INTER_AGENT_MESSAGE_CONTENT
          : `Garcon could not parse a ${issue.command} command.`,
        detail: { title: issue.command === 'send-message' ? INTER_AGENT_MESSAGE_NOTICE_TITLE : 'Agent command' },
        providerMeta: null,
      });
    }
  }
  return { drafts, commands };
}

export function dispatchGarconCommands(
  commands: readonly PendingGarconCommand[],
  options: {
    readonly chatId: string;
    readonly viewId: TranscriptViewId;
    readonly runId: string | null;
    readonly chatIdRequests: ChatIdRequestSink;
    readonly interAgentMessages: InterAgentMessageRequestSink;
    readonly agentStarts: AgentStartRequestSink;
    readonly agentSchedules: AgentScheduleRequestSink;
    readonly committedRows: readonly LedgerRow[];
  },
): void {
  for (const { command, at, requestDraftIndex } of commands) {
    switch (command.type) {
      case 'start-agent':
      case 'schedule': {
        const requestRow = options.committedRows[requestDraftIndex];
        if (!requestRow) throw new Error('Committed Garcon request row is missing');
        const source = { chatId: options.chatId, viewId: options.viewId,
          requestOrdinal: requestRow.ordinal, runId: options.runId, at };
        if (command.type === 'start-agent') options.agentStarts.request(source, command);
        else options.agentSchedules.request(source, command);
        break;
      }
      case 'get-chat-id':
        options.chatIdRequests.request({
          chatId: options.chatId,
          viewId: options.viewId,
          runId: options.runId,
          at,
        });
        break;
      case 'send-message':
        options.interAgentMessages.request({
          sourceChatId: options.chatId,
          sourceViewId: options.viewId,
          requestAt: at,
          recipients: command.recipients,
          hideSender: command.hideSender,
          body: command.body,
        });
        break;
    }
  }
}
