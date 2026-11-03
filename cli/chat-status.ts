import type { ChatSnapshotResponse } from '@garcon/common/chat-snapshot';
import type { AskUserQuestionAnswerPayload } from '@garcon/common/ask-user-question-response';
import type { CliConnectionOptions, StatusCliCommand } from './args.js';
import { connectionCommandPrefix } from './connection-options.js';
import { CliError } from './errors.js';
import { GarconHttpError } from './garcon-client.js';
import type { CliOutput } from './output.js';
import { shellQuote } from './shell-quote.js';
import { terminalBody, terminalLine } from './terminal-output.js';
import { effectiveExecutorId } from '@garcon/common/executors';
import {
  formatPermissionRequestedTool,
  formatTranscriptMessage,
} from './transcript-message-format.js';

export interface ChatStatusClient {
  getChatSnapshot(
    chatId: string,
    messageLimit: number,
    signal?: AbortSignal,
  ): Promise<ChatSnapshotResponse>;
}

export async function runChatStatus(
  command: StatusCliCommand,
  client: ChatStatusClient,
  output: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  let snapshot: ChatSnapshotResponse;
  try {
    snapshot = await client.getChatSnapshot(command.chatId, command.messageLimit, signal);
  } catch (error) {
    if (error instanceof GarconHttpError && error.errorCode === 'SESSION_NOT_FOUND') {
      throw new CliError(
        'chat status',
        'Session not found (HTTP 404, SESSION_NOT_FOUND)',
        2,
        { cause: error },
      );
    }
    throw error;
  }
  output.result(command.json
    ? JSON.stringify(snapshot, null, 2)
    : formatChatStatus(snapshot, command));
}

export function formatChatStatus(
  snapshot: ChatSnapshotResponse,
  connection?: CliConnectionOptions,
): string {
  const lines = [
    `chat id: ${snapshot.chat.id}`,
    `executor: ${effectiveExecutorId(snapshot.chat.executorId)}`,
    `status: ${snapshot.processingPhase ?? 'idle'}`,
    `observed at: ${snapshot.observedAt}`,
    `title: ${terminalLine(snapshot.chat.title)}`,
    `agent: ${snapshot.chat.agentId}`,
    `ownership epoch: ${snapshot.chat.agentOwnershipEpoch}`,
    `carryover revision: ${snapshot.chat.carryOverRevision}`,
  ];
  if (snapshot.chat.model !== null) lines.push(`model: ${snapshot.chat.model}`);
  if (snapshot.chat.apiProviderId !== null) {
    lines.push(`provider: ${snapshot.chat.apiProviderId}`);
  }
  if (snapshot.chat.modelEndpointId !== null) {
    lines.push(`endpoint: ${snapshot.chat.modelEndpointId}`);
  }
  if (snapshot.chat.modelProtocol !== null) {
    lines.push(`protocol: ${snapshot.chat.modelProtocol}`);
  }
  lines.push(
    `project path: ${terminalLine(snapshot.chat.projectPath)}`,
    `tags: ${snapshot.chat.tags.length > 0 ? snapshot.chat.tags.join(', ') : 'none'}`,
    `queue: ${snapshot.control.queue.entries.length}`,
  );
  if (snapshot.control.queue.steeringEntryId !== null) {
    lines.push(`queue steering: ${snapshot.control.queue.steeringEntryId}`);
  }
  if (snapshot.control.queue.pause !== null) {
    lines.push(`queue paused: ${snapshot.control.queue.pause.kind}`);
  }
  if (snapshot.transientFeed.rows.length > 0) {
    lines.push(`pending permissions: ${snapshot.transientFeed.rows.length}`);
    for (const row of snapshot.transientFeed.rows) {
      const message = row.message;
      const questionTool = message.requestedTool.type === 'ask-user-question-tool-use'
        ? message.requestedTool
        : null;
      const allowsFreeText = questionTool?.questions.some((question) => question.allowFreeText) ?? false;
      const allowsNotes = questionTool?.questions.some((question) => question.allowNotes) ?? false;
      lines.push(
        '',
        `permission occurrence: ${row.permissionOccurrenceId}`,
        `permission run: ${row.runId}`,
        `permission server instance: ${snapshot.transientFeed.serverInstanceId}`,
        `requested tool: ${message.requestedTool.type}`,
        `requested tool details:\n${formatPermissionRequestedTool(message.requestedTool)}`,
      );
      if (message.reason) lines.push(`permission reason: ${terminalLine(message.reason)}`);
      if (questionTool) {
        lines.push(allowsFreeText
          ? 'action: use permission-answer with the exact question IDs above and option selections or free text where allowed'
          : 'action: use permission-answer with the exact question and option IDs above');
        if (allowsNotes) lines.push('notes: selected options may include text when allowNotes is true');
      }
      if (connection) {
        if (questionTool) {
          const hasOptions = questionTool.questions.some((question) => question.options.length > 0);
          const appendAnswerTemplate = (label: string, answer: AskUserQuestionAnswerPayload): void => {
            lines.push(`${label}: ${permissionAnswerCommand(
              connection,
              snapshot,
              row.permissionOccurrenceId,
              row.runId,
              answer,
            )}`);
          };
          if (!allowsFreeText || hasOptions) {
            appendAnswerTemplate('answer command template', {
              questionId: 'QUESTION_ID', selectedOptionIds: ['OPTION_ID'],
            });
          }
          if (allowsFreeText) {
            appendAnswerTemplate('text answer command template', {
              questionId: 'QUESTION_ID', selectedOptionIds: [], text: 'ANSWER_TEXT',
            });
          }
          if (allowsNotes) {
            appendAnswerTemplate('option with notes command template', {
              questionId: 'QUESTION_ID', selectedOptionIds: ['OPTION_ID'], text: 'NOTE_TEXT',
            });
          }
        } else {
          lines.push(`allow command: ${permissionDecisionCommand(
            connection,
            snapshot,
            row.permissionOccurrenceId,
            row.runId,
            'allow',
          )}`);
        }
        lines.push(`deny command: ${permissionDecisionCommand(
          connection,
          snapshot,
          row.permissionOccurrenceId,
          row.runId,
          'deny',
        )}`);
      }
    }
  }
  if (snapshot.transcript.availability === 'unavailable') {
    lines.push(
      `transcript: unavailable (${snapshot.transcript.errorCode}, retryable: `
        + `${snapshot.transcript.retryable ? 'yes' : 'no'})`,
      `transcript message: ${snapshot.transcript.message}`,
    );
  } else if (snapshot.transcript.availability === 'available') {
    lines.push(
      `transcript: view ${snapshot.transcript.transcriptViewId}, `
        + `last ordinal ${snapshot.transcript.lastOrdinal}, `
        + `showing ${snapshot.transcript.messages.length}`
        + (snapshot.transcript.hasMore ? ', older messages available' : ''),
    );
    for (const entry of snapshot.transcript.messages) {
      lines.push('', formatTranscriptMessage(entry));
    }
  }
  return terminalBody(lines.join('\n'));
}

function permissionAnswerCommand(
  connection: CliConnectionOptions,
  snapshot: ChatSnapshotResponse,
  permissionOccurrenceId: string,
  runId: string,
  answer: AskUserQuestionAnswerPayload,
): string {
  return [
    ...connectionCommandPrefix(connection),
    'permission-answer',
    shellQuote(snapshot.chat.id),
    shellQuote(permissionOccurrenceId),
    '--answers',
    shellQuote(JSON.stringify([answer])),
    '--run',
    shellQuote(runId),
    '--server-instance',
    shellQuote(snapshot.transientFeed.serverInstanceId),
  ].join(' ');
}

function permissionDecisionCommand(
  connection: CliConnectionOptions,
  snapshot: ChatSnapshotResponse,
  permissionOccurrenceId: string,
  runId: string,
  decision: 'allow' | 'deny',
): string {
  return [
    ...connectionCommandPrefix(connection),
    'permission-decision',
    shellQuote(snapshot.chat.id),
    shellQuote(permissionOccurrenceId),
    decision,
    '--run',
    shellQuote(runId),
    '--server-instance',
    shellQuote(snapshot.transientFeed.serverInstanceId),
  ].join(' ');
}
