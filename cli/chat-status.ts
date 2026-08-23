import type { ChatSnapshotResponse } from '@garcon/common/chat-snapshot';
import type { TranscriptMessage } from '@garcon/common/chat-view';
import { isCliRowPresentationDetail } from '@garcon/common/chat-types';
import type { StatusCliCommand } from './args.js';
import { CliError } from './errors.js';
import { GarconHttpError } from './garcon-client.js';
import type { CliOutput } from './output.js';

const STATUS_MESSAGE_TEXT_LIMIT = 4_000;
const DATA_URL_OMISSION = '[data URL omitted from text output]';
const TRUNCATION_MARKER = '... [truncated; use export for the complete transcript]';

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
    : formatChatStatus(snapshot));
}

export function formatChatStatus(snapshot: ChatSnapshotResponse): string {
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
      lines.push('', formatMessage(entry));
    }
  }
  return lines.join('\n');
}

function formatMessage(entry: TranscriptMessage): string {
  const { type, timestamp, ...payload } = entry.message;
  const messageDetail = 'detail' in entry.message ? entry.message.detail : undefined;
  const cliDetail = isCliRowPresentationDetail(messageDetail) ? messageDetail : null;
  const images = 'images' in payload && Array.isArray(payload.images)
    ? payload.images
    : undefined;
  const textPayload = { ...payload } as Record<string, unknown>;
  delete textPayload.images;
  delete textPayload.title;
  delete textPayload.presentation;
  let content = typeof textPayload.content === 'string'
    ? redactDataUrl(textPayload.content)
    : JSON.stringify(textPayload, redactDataUrls, 2) ?? '{}';
  if (images && images.length > 0) {
    content += `\n[${images.length} image attachments omitted from text output]`;
  }
  const userPresentation = entry.message.type === 'user-message'
    ? entry.message.presentation
    : undefined;
  const titleValue = userPresentation?.title
    ?? ('title' in entry.message && typeof entry.message.title === 'string'
      ? entry.message.title
      : undefined);
  const title = titleValue ? ` — ${titleValue}` : '';
  const cliLabel = userPresentation
    ? ` (CLI ${userPresentation.style})`
    : cliDetail ? ' (CLI)' : '';
  return `[${entry.ordinal}] ${timestamp} ${type}${cliLabel}${title}\n`
    + truncateStatusText(content);
}

function redactDataUrls(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? redactDataUrl(value) : value;
}

function redactDataUrl(value: string): string {
  return value.startsWith('data:') ? DATA_URL_OMISSION : value;
}

function truncateStatusText(content: string): string {
  if (content.length <= STATUS_MESSAGE_TEXT_LIMIT) return content;
  return `${content.slice(0, STATUS_MESSAGE_TEXT_LIMIT)}${TRUNCATION_MARKER}`;
}
