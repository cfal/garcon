import crypto from 'node:crypto';
import path from 'node:path';
import type { ChatHandoffArtifactResponse } from '@garcon/common/chat-handoff-artifact-contracts';
import type { HandoffCliCommand } from './args.js';
import {
  publishAtomicDocument,
  refuseExistingDocumentOutput,
  type AtomicDocumentFileSystem,
} from './atomic-document-output.js';
import type { CliOutput } from './output.js';

export interface ChatHandoffArtifactClient {
  getChatHandoffArtifact(
    request: Pick<HandoffCliCommand, 'chatId' | 'contextWindowTokens'>,
    signal?: AbortSignal,
  ): Promise<ChatHandoffArtifactResponse>;
}

export async function runChatHandoff(
  command: HandoffCliCommand,
  client: ChatHandoffArtifactClient,
  output: Pick<CliOutput, 'document' | 'result'>,
  signal?: AbortSignal,
  fileSystem?: AtomicDocumentFileSystem,
): Promise<void> {
  const outputPath = command.outputPath === undefined
    ? undefined
    : path.resolve(command.outputPath);
  if (outputPath !== undefined && !command.force) {
    await refuseExistingDocumentOutput({
      outputPath,
      phase: 'handoff artifact',
      noun: 'handoff artifact',
      fileSystem,
    });
  }

  const response = await client.getChatHandoffArtifact({
    chatId: command.chatId,
    contextWindowTokens: command.contextWindowTokens,
  }, signal);
  signal?.throwIfAborted();

  if (outputPath === undefined) {
    output.document(response.document);
    return;
  }

  await publishAtomicDocument({
    outputPath,
    document: response.document,
    force: command.force,
    phase: 'handoff artifact',
    noun: 'handoff artifact',
    temporarySuffix: 'garcon-handoff',
    signal,
    fileSystem,
  });
  output.result(renderHandoffReceipt(response, outputPath));
}

function renderHandoffReceipt(
  response: ChatHandoffArtifactResponse,
  outputPath: string,
): string {
  const bytes = new TextEncoder().encode(response.document);
  return [
    'operation: read-only handoff artifact',
    `chat id: ${response.chatId}`,
    `output: ${outputPath}`,
    `generated at: ${response.generatedAt}`,
    `transcript view id: ${response.transcriptViewId}`,
    `last ordinal: ${response.lastOrdinal}`,
    `context window: ${response.contextWindowTokens} tokens`,
    `usable artifact budget: ${response.usableTokenBudget} tokens (75%; usage estimated)`,
    `artifact estimate: ${response.estimatedTokens} tokens`,
    `entries: ${response.includedEntryCount} of ${response.totalEntryCount}`,
    `omitted entries: ${response.omittedEntryCount}`,
    `abridged entries: ${response.abridgedEntryCount}`,
    `gaps: ${response.gapCount}`,
    `truncated: ${response.truncated ? 'yes' : 'no'}`,
    `code units: ${response.documentCodeUnits}`,
    `bytes: ${bytes.byteLength}`,
    `sha256: ${crypto.createHash('sha256').update(bytes).digest('hex')}`,
  ].join('\n');
}
