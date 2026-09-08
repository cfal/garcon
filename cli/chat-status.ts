import type { ChatSnapshotResponse } from '@garcon/common/chat-snapshot';
import type { StatusCliCommand } from './args.js';
import { CliError } from './errors.js';
import { GarconHttpError } from './garcon-client.js';
import type { CliOutput } from './output.js';
import { PermissionRequestMessage } from '@garcon/common/chat-types';
import { shellQuote } from './shell-quote.js';
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
        `Session not found in Garcon workspace "${command.workspace}" `
          + '(HTTP 404, SESSION_NOT_FOUND)',
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
  connection?: Pick<StatusCliCommand, 'workspace' | 'configDir' | 'serverUrl'>,
): string {
  const lines = [
    `chat id: ${snapshot.chat.id}`,
    `status: ${snapshot.processingPhase ?? 'idle'}`,
    `observed at: ${snapshot.observedAt}`,
    `title: ${snapshot.chat.title}`,
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
    `project path: ${snapshot.chat.projectPath}`,
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
      if (!(message instanceof PermissionRequestMessage)) continue;
      const structured = message.requestedTool.type === 'ask-user-question-tool-use'
        || message.requestedTool.type === 'cursor-ask-question-tool-use';
      lines.push(
        '',
        `permission occurrence: ${row.permissionOccurrenceId}`,
        `permission run: ${row.runId}`,
        `permission server instance: ${snapshot.transientFeed.serverInstanceId}`,
        `requested tool: ${message.requestedTool.type}`,
        `requested tool details:\n${formatPermissionRequestedTool(message.requestedTool)}`,
      );
      if (structured) {
        lines.push(
          'action: use permission-answer with the exact question and option IDs above',
        );
      }
      if (connection) {
        if (structured) {
          lines.push(`answer command template: ${permissionAnswerCommand(
            connection,
            snapshot,
            row.permissionOccurrenceId,
            row.runId,
          )}`);
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
  return lines.join('\n');
}

function permissionAnswerCommand(
  connection: Pick<StatusCliCommand, 'workspace' | 'configDir' | 'serverUrl'>,
  snapshot: ChatSnapshotResponse,
  permissionOccurrenceId: string,
  runId: string,
): string {
  return [
    ...permissionCommandPrefix(connection),
    'permission-answer',
    shellQuote(snapshot.chat.id),
    shellQuote(permissionOccurrenceId),
    '--answers',
    shellQuote('[{"questionId":"QUESTION_ID","selectedOptionIds":["OPTION_ID"]}]'),
    '--run',
    shellQuote(runId),
    '--server-instance',
    shellQuote(snapshot.transientFeed.serverInstanceId),
  ].join(' ');
}

function permissionDecisionCommand(
  connection: Pick<StatusCliCommand, 'workspace' | 'configDir' | 'serverUrl'>,
  snapshot: ChatSnapshotResponse,
  permissionOccurrenceId: string,
  runId: string,
  decision: 'allow' | 'deny',
): string {
  return [
    ...permissionCommandPrefix(connection),
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

function permissionCommandPrefix(
  connection: Pick<StatusCliCommand, 'workspace' | 'configDir' | 'serverUrl'>,
): string[] {
  return [
    'garcon-cli',
    '--workspace',
    shellQuote(connection.workspace),
    '--config-dir',
    shellQuote(connection.configDir),
    ...(connection.serverUrl === undefined
      ? []
      : ['--server', shellQuote(connection.serverUrl)]),
  ];
}
