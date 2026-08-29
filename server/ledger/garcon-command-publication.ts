import type { AgentProducedRow } from '@garcon/server-agent-interface';
import type { ChatId } from '../../common/chat-id.js';
import {
  extractGarconCommands,
  INTER_AGENT_MESSAGE_NOTICE_TITLE,
  MALFORMED_INTER_AGENT_MESSAGE_CONTENT,
  MALFORMED_SUB_AGENT_START_CONTENT,
  SUB_AGENT_START_NOTICE_TITLE,
  type GarconCreateChatParams,
  type GarconEdgeCommand,
} from '../../common/garcon-commands.js';
import type { LedgerRowDraft, TranscriptViewId } from './contracts.js';
import {
  chatIdRequestNoticeDraft,
  interAgentSendRequestNoticeDraft,
  subAgentStartRequestNoticeDraft,
} from './garcon-command-request.js';

export interface ChatIdRequestSink {
  request(input: {
    readonly chatId: string;
    readonly viewId: TranscriptViewId;
    readonly runId: string | null;
    readonly at: string;
  }): void;
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

export interface AgentStartRequestSink {
  request(input: {
    readonly sourceChatId: string;
    readonly sourceViewId: TranscriptViewId;
    readonly requestRunId: string | null;
    readonly requestAt: string;
    readonly prompt: string;
    readonly params: readonly GarconCreateChatParams[];
  }): void;
}

export const DISABLED_CHAT_ID_REQUEST_SINK: ChatIdRequestSink = Object.freeze({
  request: () => undefined,
});

export const DISABLED_INTER_AGENT_MESSAGE_SINK: InterAgentMessageRequestSink = Object.freeze({
  request: () => undefined,
});

export const DISABLED_AGENT_START_SINK: AgentStartRequestSink = Object.freeze({
  request: () => undefined,
});

interface PendingGarconCommand {
  readonly command: GarconEdgeCommand;
  readonly at: string;
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
      commands.push({ command, at: row.message.timestamp });
      switch (command.type) {
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
        case 'start-agent':
          drafts.push(subAgentStartRequestNoticeDraft(row.message.timestamp, {
            prompt: command.prompt,
            params: command.params,
          }));
          break;
      }
    }
    for (const issue of transformed.issues) {
      const malformed = issue.command === 'start-agent'
        ? {
            title: SUB_AGENT_START_NOTICE_TITLE,
            content: MALFORMED_SUB_AGENT_START_CONTENT,
          }
        : {
            title: INTER_AGENT_MESSAGE_NOTICE_TITLE,
            content: MALFORMED_INTER_AGENT_MESSAGE_CONTENT,
          };
      drafts.push({
        kind: 'notice',
        at: row.message.timestamp,
        message: malformed.content,
        detail: { title: malformed.title },
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
  },
): void {
  for (const { command, at } of commands) {
    switch (command.type) {
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
      case 'start-agent':
        options.agentStarts.request({
          sourceChatId: options.chatId,
          sourceViewId: options.viewId,
          requestRunId: options.runId,
          requestAt: at,
          prompt: command.prompt,
          params: command.params,
        });
        break;
    }
  }
}
